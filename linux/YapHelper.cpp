// Yap native helper for Linux (X11).
//
// Speaks the same JSON-lines protocol as the macOS helper (`yap-helper serve`):
// commands arrive on stdin as {"id":N,"cmd":"...",...}, replies go to stdout as
// {"id":N,"ok":true,"result":{...}}, and hotkey changes are pushed as
// {"event":"hotkey","state":"down"|"up"|"chord"}.
//
// The hotkey is observed through XInput2 raw key events on the root window.
// Raw events reach every client that asks for them, so nothing is grabbed or
// swallowed: other apps see the keys exactly as typed, and modifier-only keys
// such as Right Alt / AltGr work as push-to-talk. Paste is a synthetic
// Ctrl+V (Ctrl+Shift+V in terminals) through XTest; the clipboard itself is
// handled by Electron in the main process.
//
// Build: g++ -O2 -o yap-helper YapHelper.cpp -lX11 -lXi -lXtst

#include <X11/XKBlib.h>
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XInput2.h>
#include <X11/extensions/XTest.h>

#include <poll.h>
#include <signal.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

static const char* kHelperVersion = "linux-1";

// ── Output ──────────────────────────────────────────────────────────────

static std::string jsonString(const std::string& value) {
    std::string out = "\"";
    for (unsigned char c : value) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    return out + "\"";
}

static void sendLine(const std::string& line) {
    fputs(line.c_str(), stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static void reply(long id, const std::string& result) {
    sendLine("{\"id\":" + std::to_string(id) + ",\"ok\":true,\"result\":" + result + "}");
}

static void replyError(long id, const std::string& message) {
    sendLine("{\"id\":" + std::to_string(id) + ",\"ok\":false,\"error\":" + jsonString(message) + "}");
}

static void emitHotkey(const char* state) {
    sendLine(std::string("{\"event\":\"hotkey\",\"state\":\"") + state + "\"}");
}

// ── Minimal JSON field extraction (commands are flat objects) ───────────

static const char* findField(const std::string& json, const char* key) {
    std::string needle = std::string("\"") + key + "\"";
    size_t pos = json.find(needle);
    if (pos == std::string::npos) return nullptr;
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return nullptr;
    const char* p = json.c_str() + pos + 1;
    while (*p == ' ' || *p == '\t') p++;
    return p;
}

static long numberField(const std::string& json, const char* key, long fallback) {
    const char* p = findField(json, key);
    if (!p || !(*p == '-' || isdigit(static_cast<unsigned char>(*p)))) return fallback;
    return strtol(p, nullptr, 10);
}

static bool boolField(const std::string& json, const char* key, bool fallback) {
    const char* p = findField(json, key);
    if (!p) return fallback;
    if (strncmp(p, "true", 4) == 0) return true;
    if (strncmp(p, "false", 5) == 0) return false;
    return fallback;
}

static std::string stringField(const std::string& json, const char* key) {
    const char* p = findField(json, key);
    if (!p || *p != '"') return "";
    std::string out;
    for (p++; *p && *p != '"'; p++) {
        if (*p == '\\' && p[1]) p++;
        out += *p;
    }
    return out;
}

// ── Key codes ───────────────────────────────────────────────────────────

// Yap stores hotkeys with macOS virtual key codes and generic modifier flags.
static const unsigned long MAC_COMMAND = 0x100000;
static const unsigned long MAC_OPTION = 0x80000;
static const unsigned long MAC_SHIFT = 0x20000;
static const unsigned long MAC_CONTROL = 0x40000;
static const long MAC_FN = 63;
// Mouse buttons are stored as 1000 + X11 button number and tracked as virtual
// key codes 256 + button, next to the real ones.
static const long MOUSE_BASE = 1000;
static const int MOUSE_VIRTUAL = 256;
static const int KEY_SLOTS = 320;

// X keycodes under the evdev driver (Linux input code + 8). They name
// physical keys, which is what the hotkey recorder captures (KeyboardEvent.code).
static const int XK_LCTRL = 37, XK_RCTRL = 105;
static const int XK_LSHIFT = 50, XK_RSHIFT = 62;
static const int XK_LALT = 64, XK_RALT = 108;
static const int XK_LSUPER = 133, XK_RSUPER = 134;

static bool isMouseVirtual(int kc) { return kc > MOUSE_VIRTUAL && kc < KEY_SLOTS; }

static int macToX(long mac) {
    // Buttons 4-7 are the wheel. Left/right (1/3) need a modifier, checked in startListening.
    if (mac > MOUSE_BASE && mac < MOUSE_BASE + (KEY_SLOTS - MOUSE_VIRTUAL)) {
        long button = mac - MOUSE_BASE;
        if (button <= 3 || button >= 8) return MOUSE_VIRTUAL + static_cast<int>(button);
        return 0;
    }
    switch (mac) {
        // Modifiers
        case 55: return XK_LSUPER;
        case 54: return XK_RSUPER;
        case 58: return XK_LALT;
        case 61: return XK_RALT;
        case 56: return XK_LSHIFT;
        case 60: return XK_RSHIFT;
        case 59: return XK_LCTRL;
        case 62: return XK_RCTRL;
        // Letters
        case 0: return 30 + 8;   // A
        case 11: return 48 + 8;  // B
        case 8: return 46 + 8;   // C
        case 2: return 32 + 8;   // D
        case 14: return 18 + 8;  // E
        case 3: return 33 + 8;   // F
        case 5: return 34 + 8;   // G
        case 4: return 35 + 8;   // H
        case 34: return 23 + 8;  // I
        case 38: return 36 + 8;  // J
        case 40: return 37 + 8;  // K
        case 37: return 38 + 8;  // L
        case 46: return 50 + 8;  // M
        case 45: return 49 + 8;  // N
        case 31: return 24 + 8;  // O
        case 35: return 25 + 8;  // P
        case 12: return 16 + 8;  // Q
        case 15: return 19 + 8;  // R
        case 1: return 31 + 8;   // S
        case 17: return 20 + 8;  // T
        case 32: return 22 + 8;  // U
        case 9: return 47 + 8;   // V
        case 13: return 17 + 8;  // W
        case 7: return 45 + 8;   // X
        case 16: return 21 + 8;  // Y
        case 6: return 44 + 8;   // Z
        // Digits
        case 29: return 11 + 8;  // 0
        case 18: return 2 + 8;   // 1
        case 19: return 3 + 8;   // 2
        case 20: return 4 + 8;   // 3
        case 21: return 5 + 8;   // 4
        case 23: return 6 + 8;   // 5
        case 22: return 7 + 8;   // 6
        case 26: return 8 + 8;   // 7
        case 28: return 9 + 8;   // 8
        case 25: return 10 + 8;  // 9
        // Common keys
        case 49: return 57 + 8;  // Space
        case 36: return 28 + 8;  // Enter
        case 48: return 15 + 8;  // Tab
        case 51: return 14 + 8;  // Backspace
        case 53: return 1 + 8;   // Escape
        // Function keys
        case 122: return 59 + 8;  // F1
        case 120: return 60 + 8;  // F2
        case 99: return 61 + 8;   // F3
        case 118: return 62 + 8;  // F4
        case 96: return 63 + 8;   // F5
        case 97: return 64 + 8;   // F6
        case 98: return 65 + 8;   // F7
        case 100: return 66 + 8;  // F8
        case 101: return 67 + 8;  // F9
        case 109: return 68 + 8;  // F10
        case 103: return 87 + 8;  // F11
        case 111: return 88 + 8;  // F12
        case 105: return 183 + 8; // F13
        case 107: return 184 + 8; // F14
        case 113: return 185 + 8; // F15
        default: return 0;
    }
}

static bool isModifierKeycode(int kc) {
    return kc == XK_LCTRL || kc == XK_RCTRL || kc == XK_LSHIFT || kc == XK_RSHIFT ||
           kc == XK_LALT || kc == XK_RALT || kc == XK_LSUPER || kc == XK_RSUPER;
}

// ── State ───────────────────────────────────────────────────────────────

static Display* dpy = nullptr;
static Window root = 0;
static int xiOpcode = -1;
static bool xiReady = false;
static bool xtestReady = false;

static bool keyDown[KEY_SLOTS] = {};
static unsigned int grabbedButton = 0;

static int targetKeycode = 0;          // 0: not listening
static unsigned long targetModifiers = 0;
static bool hotkeyIsDown = false;
static bool hotkeyChorded = false;
static bool listenerActive = false;
static std::string listenerError;
static std::string listenerErrorCode;

static int ignoreXErrors(Display*, XErrorEvent*) { return 0; }

static void syncKeymap() {
    if (!dpy) return;
    char keys[32];
    XQueryKeymap(dpy, keys);
    for (int kc = 0; kc < 256; kc++) {
        keyDown[kc] = (keys[kc / 8] >> (kc % 8)) & 1;
    }
    for (int kc = 256; kc < KEY_SLOTS; kc++) keyDown[kc] = false;
}

static bool modifiersHeld(unsigned long modifiers) {
    if ((modifiers & MAC_COMMAND) && !keyDown[XK_LSUPER] && !keyDown[XK_RSUPER]) return false;
    if ((modifiers & MAC_OPTION) && !keyDown[XK_LALT] && !keyDown[XK_RALT]) return false;
    if ((modifiers & MAC_SHIFT) && !keyDown[XK_LSHIFT] && !keyDown[XK_RSHIFT]) return false;
    if ((modifiers & MAC_CONTROL) && !keyDown[XK_LCTRL] && !keyDown[XK_RCTRL]) return false;
    return true;
}

static std::string listenerStatus() {
    std::string out = "{\"active\":";
    out += listenerActive ? "true" : "false";
    out += ",\"mode\":";
    out += listenerActive ? "\"listen-only\"" : "null";
    out += ",\"error\":";
    out += listenerError.empty() ? "null" : jsonString(listenerError);
    out += ",\"errorCode\":";
    out += listenerErrorCode.empty() ? "null" : jsonString(listenerErrorCode);
    return out + "}";
}

// ── Hotkey evaluation (mirrors the macOS helper) ────────────────────────

static void handleKey(int kc, bool press) {
    if (kc <= 0 || kc >= KEY_SLOTS) return;
    bool wasDown = keyDown[kc];
    keyDown[kc] = press;
    // Raw events carry no autorepeat; a second press without release is a repeat anyway.
    if (press && wasDown) return;
    if (!targetKeycode) return;

    bool targetIsModifier = isModifierKeycode(targetKeycode);
    bool changed = false;
    bool next = hotkeyIsDown;

    if (kc == targetKeycode) {
        if (targetIsModifier) {
            next = press && (targetModifiers == 0 || modifiersHeld(targetModifiers));
            changed = true;
        } else if (press) {
            if (targetModifiers == 0 || modifiersHeld(targetModifiers)) {
                next = true;
                changed = true;
            }
        } else {
            next = false;
            changed = true;
        }
    }

    if (changed && next != hotkeyIsDown) {
        hotkeyIsDown = next;
        hotkeyChorded = false;
        emitHotkey(next ? "down" : "up");
        return;
    }

    // A modifier hotkey used as a modifier (AltGr + Q for @, Ctrl + C) is not
    // a dictation. Tell the app once per press so it drops the recording.
    if (press && hotkeyIsDown && !hotkeyChorded && kc != targetKeycode && targetIsModifier) {
        hotkeyChorded = true;
        emitHotkey("chord");
    }
}

static void drainX() {
    while (XPending(dpy)) {
        XEvent ev;
        XNextEvent(dpy, &ev);
        // While our passive grab on the dictation button is active, the X server
        // filters our own raw events (they count as delivered through the grab),
        // so the release only arrives as a core event. Both paths feed handleKey,
        // which ignores the duplicate.
        if ((ev.type == ButtonPress || ev.type == ButtonRelease) && grabbedButton &&
            ev.xbutton.button == grabbedButton) {
            handleKey(MOUSE_VIRTUAL + static_cast<int>(grabbedButton), ev.type == ButtonPress);
            continue;
        }
        if (ev.type != GenericEvent || ev.xcookie.extension != xiOpcode) continue;
        if (!XGetEventData(dpy, &ev.xcookie)) continue;
        if (ev.xcookie.evtype == XI_RawKeyPress || ev.xcookie.evtype == XI_RawKeyRelease) {
            auto* raw = static_cast<XIRawEvent*>(ev.xcookie.data);
            bool repeat = (raw->flags & XIKeyRepeat) != 0;
            if (!repeat) handleKey(raw->detail, ev.xcookie.evtype == XI_RawKeyPress);
        } else if (ev.xcookie.evtype == XI_RawButtonPress || ev.xcookie.evtype == XI_RawButtonRelease) {
            auto* raw = static_cast<XIRawEvent*>(ev.xcookie.data);
            int button = raw->detail;
            // Left/right only count through the modifier grab (core events above): a
            // plain click must stay a click.
            if (button == 2 || (button >= 8 && MOUSE_VIRTUAL + button < KEY_SLOTS)) {
                handleKey(MOUSE_VIRTUAL + button, ev.xcookie.evtype == XI_RawButtonPress);
            }
        }
        XFreeEventData(dpy, &ev.xcookie);
    }
}

static unsigned int grabbedMask = 0;

static unsigned int xModifierMask(unsigned long mac) {
    unsigned int mask = 0;
    if (mac & MAC_CONTROL) mask |= ControlMask;
    if (mac & MAC_SHIFT) mask |= ShiftMask;
    if (mac & MAC_OPTION) mask |= Mod1Mask;
    if (mac & MAC_COMMAND) mask |= Mod4Mask;
    return mask;
}

/**
 * Keeps the dictation button from also reaching apps (Back in a browser,
 * middle-click paste). Left and right are grabbed only together with their
 * modifiers, so ordinary clicks keep working.
 */
static void grabMouseButton(unsigned int button, unsigned long macModifiers) {
    if (!dpy) return;
    unsigned int mask = (button == 1 || button == 3) ? xModifierMask(macModifiers) : AnyModifier;
    if (button == grabbedButton && mask == grabbedMask) return;
    if (grabbedButton) XUngrabButton(dpy, grabbedButton, AnyModifier, root);
    grabbedButton = button;
    grabbedMask = mask;
    if (button) {
        const unsigned int events = ButtonPressMask | ButtonReleaseMask;
        if (mask == AnyModifier) {
            XGrabButton(dpy, button, AnyModifier, root, False, events, GrabModeAsync, GrabModeAsync, None, None);
        } else {
            // Exact-modifier grabs would miss with Caps Lock or Num Lock on.
            const unsigned int locks[] = {0, LockMask, Mod2Mask, LockMask | Mod2Mask};
            for (unsigned int lock : locks) {
                XGrabButton(dpy, button, mask | lock, root, False, events, GrabModeAsync, GrabModeAsync, None, None);
            }
        }
    }
    XFlush(dpy);
}

static void startListening(long macKey, unsigned long modifiers) {
    bool changed = targetKeycode != macToX(macKey) || targetModifiers != modifiers;
    if (changed && hotkeyIsDown) emitHotkey("up");
    if (changed) {
        hotkeyIsDown = false;
        hotkeyChorded = false;
    }

    listenerError.clear();
    listenerErrorCode.clear();
    listenerActive = false;
    targetKeycode = 0;
    targetModifiers = modifiers;
    grabMouseButton(0, 0);

    if (!dpy) {
        listenerError = "No X11 display. Yap needs an X11 session (Wayland is not supported).";
        return;
    }
    if (!xiReady) {
        listenerError = "The X server has no XInput2 support.";
        return;
    }
    if (macKey == MAC_FN) {
        listenerError = "Fn key is handled by the keyboard firmware on Linux. Please choose a different dictation key.";
        listenerErrorCode = "fn-unsupported";
        return;
    }
    int kc = macToX(macKey);
    if (!kc) {
        listenerError = "Unsupported key code for Linux.";
        listenerErrorCode = "key-unsupported";
        return;
    }

    unsigned int button = isMouseVirtual(kc) ? static_cast<unsigned int>(kc - MOUSE_VIRTUAL) : 0;
    if ((button == 1 || button == 3) && xModifierMask(modifiers) == 0) {
        listenerError = "Left and right click need a modifier (e.g. Ctrl + right click).";
        listenerErrorCode = "key-unsupported";
        return;
    }

    targetKeycode = kc;
    syncKeymap();
    grabMouseButton(button, modifiers);
    if (changed) hotkeyIsDown = false;
    listenerActive = true;
}

// ── Focus ───────────────────────────────────────────────────────────────

struct FocusWindow {
    Window window = 0;
    std::string resClass;
    std::string resName;
    long pid = 0;
};

static Window activeWindow() {
    Atom prop = XInternAtom(dpy, "_NET_ACTIVE_WINDOW", False);
    Atom type;
    int format;
    unsigned long count, after;
    unsigned char* data = nullptr;
    Window result = 0;
    if (XGetWindowProperty(dpy, root, prop, 0, 1, False, XA_WINDOW, &type, &format, &count, &after, &data) == Success &&
        data && count == 1 && format == 32) {
        result = *reinterpret_cast<Window*>(data);
    }
    if (data) XFree(data);
    if (!result) {
        int revert;
        XGetInputFocus(dpy, &result, &revert);
        if (result == PointerRoot || result == None) result = 0;
    }
    return result;
}

static long windowPid(Window w) {
    Atom prop = XInternAtom(dpy, "_NET_WM_PID", False);
    Atom type;
    int format;
    unsigned long count, after;
    unsigned char* data = nullptr;
    long pid = 0;
    if (XGetWindowProperty(dpy, w, prop, 0, 1, False, XA_CARDINAL, &type, &format, &count, &after, &data) == Success &&
        data && count == 1 && format == 32) {
        pid = static_cast<long>(*reinterpret_cast<unsigned long*>(data));
    }
    if (data) XFree(data);
    return pid;
}

static FocusWindow currentFocusWindow() {
    FocusWindow focus;
    if (!dpy) return focus;
    Window w = activeWindow();
    // An input-focus window may be a child without WM_CLASS; walk up to the client.
    for (int depth = 0; w && depth < 8; depth++) {
        XClassHint hint;
        if (XGetClassHint(dpy, w, &hint)) {
            if (hint.res_class) focus.resClass = hint.res_class;
            if (hint.res_name) focus.resName = hint.res_name;
            if (hint.res_class) XFree(hint.res_class);
            if (hint.res_name) XFree(hint.res_name);
            focus.window = w;
            focus.pid = windowPid(w);
            break;
        }
        Window rootReturn, parent;
        Window* children = nullptr;
        unsigned int n;
        if (!XQueryTree(dpy, w, &rootReturn, &parent, &children, &n)) break;
        if (children) XFree(children);
        if (parent == rootReturn) break;
        w = parent;
    }
    return focus;
}

static std::string processName(long pid) {
    if (pid <= 0) return "";
    char path[64];
    snprintf(path, sizeof(path), "/proc/%ld/comm", pid);
    FILE* f = fopen(path, "r");
    if (!f) return "";
    char buf[256] = "";
    if (fgets(buf, sizeof(buf), f)) {
        size_t len = strlen(buf);
        if (len && buf[len - 1] == '\n') buf[len - 1] = 0;
    }
    fclose(f);
    return buf;
}

static std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
}

static bool isTerminal(const FocusWindow& focus) {
    static const char* terminals[] = {
        "gnome-terminal", "gnome-terminal-server", "xterm", "uxterm", "urxvt", "rxvt", "konsole",
        "xfce4-terminal", "mate-terminal", "tilix", "terminator", "kitty", "alacritty", "wezterm",
        "org.wezfurlong.wezterm", "st", "st-256color", "foot", "guake", "tilda", "yakuake", "qterminal",
        "lxterminal", "sakura", "terminology", "cool-retro-term", "x-terminal-emulator", "ghostty",
        "com.mitchellh.ghostty", "warp", "dev.warp.warp", "hyper", "tabby", "blackbox", "kgx", "ptyxis",
        "org.gnome.console", "org.gnome.ptyxis", "contour", "rio", "termite", "eterm", "aterm", nullptr,
    };
    std::string cls = lower(focus.resClass);
    std::string name = lower(focus.resName);
    for (int i = 0; terminals[i]; i++) {
        if (cls == terminals[i] || name == terminals[i]) return true;
    }
    return false;
}

static std::string focusJson() {
    FocusWindow focus = currentFocusWindow();
    if (!focus.window) return "{}";
    std::string appName = focus.resClass.empty() ? processName(focus.pid) : focus.resClass;
    std::string bundle = focus.resName.empty() ? lower(appName) : lower(focus.resName);
    std::string out = "{\"appName\":" + jsonString(appName) + ",\"bundleIdentifier\":" + jsonString(bundle);
    if (focus.pid > 0) out += ",\"processIdentifier\":" + std::to_string(focus.pid);
    out += ",\"terminal\":";
    out += isTerminal(focus) ? "true" : "false";
    return out + "}";
}

// ── Paste ───────────────────────────────────────────────────────────────

static void fakeKey(int kc, bool press) {
    XTestFakeKeyEvent(dpy, static_cast<unsigned int>(kc), press ? True : False, CurrentTime);
}

static std::string paste(bool selfEditable, long ownPid) {
    if (!dpy || !xtestReady) return "{\"ok\":false,\"reason\":\"unavailable\"}";

    FocusWindow focus = currentFocusWindow();
    if (ownPid > 0 && focus.pid == ownPid && !selfEditable) {
        return "{\"ok\":false,\"reason\":\"no-target\",\"focus\":" + jsonString(focus.resClass) + "}";
    }

    // Like `xdotool --clearmodifiers`: a still-held Shift, Alt or Super would
    // turn Ctrl+V into something else.
    char keys[32];
    XQueryKeymap(dpy, keys);
    static const int mods[] = {XK_LCTRL, XK_RCTRL, XK_LSHIFT, XK_RSHIFT, XK_LALT, XK_RALT, XK_LSUPER, XK_RSUPER};
    for (int kc : mods) {
        if ((keys[kc / 8] >> (kc % 8)) & 1) fakeKey(kc, false);
    }

    KeyCode ctrl = XKeysymToKeycode(dpy, XK_Control_L);
    KeyCode shift = XKeysymToKeycode(dpy, XK_Shift_L);
    KeyCode v = XKeysymToKeycode(dpy, XK_v);
    if (!ctrl) ctrl = XK_LCTRL;
    if (!shift) shift = XK_LSHIFT;
    if (!v) v = 47 + 8;  // physical V key on non-Latin layouts

    bool terminal = isTerminal(focus);
    fakeKey(ctrl, true);
    if (terminal) fakeKey(shift, true);
    fakeKey(v, true);
    fakeKey(v, false);
    if (terminal) fakeKey(shift, false);
    fakeKey(ctrl, false);
    XSync(dpy, False);
    drainX();

    return std::string("{\"ok\":true,\"terminal\":") + (terminal ? "true" : "false") + "}";
}

// ── Keyboard layout ─────────────────────────────────────────────────────

static void appendUtf8(std::string& out, unsigned long cp) {
    if (cp < 0x80) {
        out += static_cast<char>(cp);
    } else if (cp < 0x800) {
        out += static_cast<char>(0xC0 | (cp >> 6));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
        out += static_cast<char>(0xE0 | (cp >> 12));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (cp >> 18));
        out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    }
}

/** What the active layout prints on the letter and digit keys, by macOS key code (QWERTZ: 16 -> "z"). */
static std::string keymapJson() {
    if (!dpy) return "{}";
    XkbStateRec state;
    int group = XkbGetState(dpy, XkbUseCoreKbd, &state) == Success ? state.group : 0;
    std::string out = "{";
    bool first = true;
    for (long mac = 0; mac < 128; mac++) {
        int kc = macToX(mac);
        if (!kc || isModifierKeycode(kc)) continue;
        KeySym sym = XkbKeycodeToKeysym(dpy, static_cast<KeyCode>(kc), group, 0);
        if (sym == NoSymbol && group) sym = XkbKeycodeToKeysym(dpy, static_cast<KeyCode>(kc), 0, 0);
        unsigned long cp = 0;
        if (sym >= 0x21 && sym <= 0xff) cp = sym;                         // Latin-1
        else if ((sym & 0xff000000) == 0x01000000) cp = sym & 0x00ffffff;  // Unicode keysyms
        if (!cp) continue;
        std::string ch;
        appendUtf8(ch, cp);
        out += first ? "" : ",";
        out += "\"" + std::to_string(mac) + "\":" + jsonString(ch);
        first = false;
    }
    return out + "}";
}

// ── Commands ────────────────────────────────────────────────────────────

static const char* kPermissions = "{\"accessibility\":true,\"inputMonitoring\":true,\"postEvents\":true}";

static void handleCommand(const std::string& line) {
    long id = numberField(line, "id", 0);
    std::string cmd = stringField(line, "cmd");
    if (cmd.empty()) {
        sendLine("{\"event\":\"error\",\"message\":\"Malformed command.\"}");
        return;
    }

    if (cmd == "hello") {
        reply(id, std::string("{\"version\":\"") + kHelperVersion + "\",\"pid\":" + std::to_string(getpid()) +
                      ",\"display\":" + (dpy ? "true" : "false") + "}");
    } else if (cmd == "permissions" || cmd == "requestAccessibility" || cmd == "requestInputMonitoring") {
        reply(id, kPermissions);
    } else if (cmd == "listen") {
        startListening(numberField(line, "keyCode", 61), static_cast<unsigned long>(numberField(line, "modifiers", 0)));
        reply(id, listenerStatus());
    } else if (cmd == "stopListening") {
        if (hotkeyIsDown) emitHotkey("up");
        hotkeyIsDown = false;
        targetKeycode = 0;
        listenerActive = false;
        grabMouseButton(0, 0);
        reply(id, listenerStatus());
    } else if (cmd == "listenerStatus") {
        reply(id, listenerStatus());
    } else if (cmd == "focus") {
        reply(id, focusJson());
    } else if (cmd == "prepareClipboard") {
        reply(id, "{}");
    } else if (cmd == "paste") {
        reply(id, paste(boolField(line, "selfEditable", false), numberField(line, "ownPid", 0)));
    } else if (cmd == "keymap") {
        reply(id, keymapJson());
    } else if (cmd == "fnUsage") {
        reply(id, "{\"value\":null}");
    } else {
        replyError(id, "Unknown command " + cmd + ".");
    }
}

// ── Main loop ───────────────────────────────────────────────────────────

static void openDisplay() {
    dpy = XOpenDisplay(nullptr);
    if (!dpy) return;
    XSetErrorHandler(ignoreXErrors);
    root = DefaultRootWindow(dpy);

    int event, error;
    if (XQueryExtension(dpy, "XInputExtension", &xiOpcode, &event, &error)) {
        int major = 2, minor = 1;
        if (XIQueryVersion(dpy, &major, &minor) == Success) {
            unsigned char mask[XIMaskLen(XI_LASTEVENT)] = {};
            XISetMask(mask, XI_RawKeyPress);
            XISetMask(mask, XI_RawKeyRelease);
            XISetMask(mask, XI_RawButtonPress);
            XISetMask(mask, XI_RawButtonRelease);
            XIEventMask evmask;
            evmask.deviceid = XIAllMasterDevices;
            evmask.mask_len = sizeof(mask);
            evmask.mask = mask;
            xiReady = XISelectEvents(dpy, root, &evmask, 1) == Success;
        }
    }

    int tEvent, tError, tMajor, tMinor;
    xtestReady = XTestQueryExtension(dpy, &tEvent, &tError, &tMajor, &tMinor);
    XFlush(dpy);
}

static int serve() {
    signal(SIGPIPE, SIG_DFL);
    openDisplay();

    std::string buffer;
    char chunk[4096];
    for (;;) {
        struct pollfd fds[2];
        int n = 0;
        fds[n++] = {STDIN_FILENO, POLLIN, 0};
        if (dpy) fds[n++] = {ConnectionNumber(dpy), POLLIN, 0};

        if (dpy) drainX();
        if (poll(fds, n, -1) < 0) continue;

        if (fds[0].revents & (POLLIN | POLLHUP)) {
            ssize_t got = read(STDIN_FILENO, chunk, sizeof(chunk));
            if (got <= 0) break;  // the app went away
            buffer.append(chunk, static_cast<size_t>(got));
            size_t nl;
            while ((nl = buffer.find('\n')) != std::string::npos) {
                std::string line = buffer.substr(0, nl);
                buffer.erase(0, nl + 1);
                if (!line.empty()) handleCommand(line);
            }
        }
        if (n > 1 && (fds[1].revents & (POLLERR | POLLHUP))) {
            // The X server went away (logout); without it there is nothing to do.
            break;
        }
        if (dpy) drainX();
    }

    if (dpy) XCloseDisplay(dpy);
    return 0;
}

int main(int argc, char* argv[]) {
    if (argc >= 2 && strcmp(argv[1], "serve") == 0) return serve();

    // One-shot commands for debugging: `yap-helper focus`, `yap-helper paste`.
    openDisplay();
    if (argc >= 2 && strcmp(argv[1], "focus") == 0) {
        sendLine(focusJson());
        return 0;
    }
    if (argc >= 2 && strcmp(argv[1], "paste") == 0) {
        sendLine(paste(true, 0));
        return 0;
    }
    if (argc >= 2 && strcmp(argv[1], "keymap") == 0) {
        sendLine(keymapJson());
        return 0;
    }
    if (argc >= 2 && strcmp(argv[1], "permissions") == 0) {
        sendLine(kPermissions);
        return 0;
    }
    fprintf(stderr, "usage: yap-helper serve|focus|paste|permissions\n");
    return 1;
}
