// Fn tugmasi bosilishi/qo'yib yuborilishini kuzatadi (push-to-talk trigger),
// va Fn+Shift birga bosilishini alohida (pauza/uyg'otish trigger) aniqlaydi.
// Chiqish qatorlari: "DOWN" | "UP" (oddiy Fn) | "COMBO" (Fn+Shift birga)
// Kerak: Tizim sozlamalari -> Maxfiylik va xavfsizlik -> Input Monitoring ruxsati

import Cocoa

var fnPressed = false
var shiftPressed = false
var comboFired = false

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

            // Fn+Shift birga bosilgan payt — bitta marta "COMBO" chiqaradi
            if isFn && isShift && !comboFired {
                comboFired = true
                print("COMBO")
                fflush(stdout)
            }
            if !(isFn && isShift) {
                comboFired = false
            }

            // Oddiy Fn push-to-talk — faqat Shift bosilmagan bo'lsa
            if isFn != fnPressed {
                fnPressed = isFn
                if !isShift {
                    print(isFn ? "DOWN" : "UP")
                    fflush(stdout)
                }
            }
            shiftPressed = isShift
        }
        return Unmanaged.passRetained(event)
    },
    userInfo: nil
) else {
    print("ERROR: CGEventTap yaratib bo'lmadi — Input Monitoring ruxsati kerak")
    fflush(stdout)
    exit(1)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: eventTap, enable: true)

print("READY")
fflush(stdout)
CFRunLoopRun()
