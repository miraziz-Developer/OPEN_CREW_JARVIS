// Watches Fn presses/releases (push-to-talk trigger) and separately detects Fn+Shift
// pressed together (pause/wake trigger).
// Output lines: "DOWN" | "UP" (plain Fn) | "COMBO" (Fn+Shift together)
// Requires: System Settings -> Privacy & Security -> Input Monitoring permission

import Cocoa

var fnPressed = false
var shiftPressed = false
var comboFired = false
// Once a plain Fn DOWN was sent, a matching UP must be sent when the physical Fn is
// released, whatever the Shift state. Otherwise the daemon hangs with pttActive=true.
var plainFnDownSent = false
var pendingFnToken = 0

let eventMask = (1 << CGEventType.flagsChanged.rawValue)

guard let eventTap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: CGEventMask(eventMask),
    callback: { _, type, event, _ in
        if type == .flagsChanged {
            let flags = event.flags
            let isFn = flags.contains(.maskSecondaryFn)
            let isShift = flags.contains(.maskShift)

            // Fn+Shift pressed together: emit COMBO only once per physical combination.
            // It does not re-arm until both keys are released.
            if isFn && isShift && !comboFired {
                comboFired = true
                pendingFnToken += 1 // cancels the pending plain Fn DOWN
                print("COMBO")
                fflush(stdout)
            }
            if !isFn && !isShift {
                comboFired = false
            }

            // Plain Fn push-to-talk. Even if Shift is pressed after DOWN was sent, the UP
            // must not be lost when Fn is released.
            if isFn != fnPressed {
                fnPressed = isFn
                if isFn && !isShift {
                    // Fn and Shift are usually pressed a few ms apart, not at the same
                    // instant. Waiting 140 ms does not noticeably slow down plain Fn, but
                    // prevents a stray voice session from opening during a combo.
                    pendingFnToken += 1
                    let token = pendingFnToken
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.14) {
                        if token == pendingFnToken && fnPressed && !shiftPressed && !comboFired {
                            plainFnDownSent = true
                            print("DOWN")
                            fflush(stdout)
                        }
                    }
                } else if !isFn && plainFnDownSent {
                    pendingFnToken += 1
                    plainFnDownSent = false
                    print("UP")
                    fflush(stdout)
                } else if !isFn {
                    // If Fn is released faster than 140 ms the async DOWN has not been
                    // sent yet. Such a quick tap used to be lost entirely while macOS opened
                    // the Emoji panel. A quick non-combo tap is now delivered on release
                    // as a full DOWN/UP pair, so the daemon receives every natural Fn press.
                    let wasPlainTap = !shiftPressed && !comboFired
                    pendingFnToken += 1
                    if wasPlainTap {
                        print("DOWN")
                        print("UP")
                        fflush(stdout)
                    }
                }
            }
            shiftPressed = isShift
        }
        return Unmanaged.passRetained(event)
    },
    userInfo: nil
) else {
    print("ERROR: could not create the CGEventTap; Input Monitoring permission is required")
    fflush(stdout)
    exit(1)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: eventTap, enable: true)

print("READY")
fflush(stdout)
CFRunLoopRun()
