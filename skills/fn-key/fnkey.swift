// Fn tugmasi bosilishi/qo'yib yuborilishini kuzatadi (push-to-talk trigger),
// va Fn+Shift birga bosilishini alohida (pauza/uyg'otish trigger) aniqlaydi.
// Chiqish qatorlari: "DOWN" | "UP" (oddiy Fn) | "COMBO" (Fn+Shift birga)
// Kerak: Tizim sozlamalari -> Maxfiylik va xavfsizlik -> Input Monitoring ruxsati

import Cocoa

var fnPressed = false
var shiftPressed = false
var comboFired = false
// Oddiy Fn DOWN yuborilgan bo'lsa, fizik Fn qo'yib yuborilganda Shift holatidan
// qat'i nazar mos UP ham yuborilishi shart. Aks holda daemon pttActive=true
// holatida osilib qoladi.
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

            // Fn+Shift birga bosilgan payt — bitta fizik kombinatsiyada faqat
            // bir marta COMBO chiqaradi. Tugmalardan ikkalasi ham qo'yilmaguncha
            // qayta qurollanmaydi.
            if isFn && isShift && !comboFired {
                comboFired = true
                pendingFnToken += 1 // kutayotgan oddiy Fn DOWN'ni bekor qiladi
                print("COMBO")
                fflush(stdout)
            }
            if !isFn && !isShift {
                comboFired = false
            }

            // Oddiy Fn push-to-talk. Agar avval DOWN yuborilganidan keyin Shift
            // bosilsa ham, Fn release paytida UP yo'qolib ketmasligi kerak.
            if isFn != fnPressed {
                fnPressed = isFn
                if isFn && !isShift {
                    // Fn+Shift odatda bir vaqtda emas, bir necha ms farq bilan
                    // bosiladi. 140ms kutish oddiy Fn'ni sezilarli sekinlatmaydi,
                    // lekin combo paytida tasodifiy voice sessiya ochilishini
                    // oldini oladi.
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
                    pendingFnToken += 1
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
