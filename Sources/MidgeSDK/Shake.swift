#if os(iOS)
import ObjectiveC
import UIKit

/// Shaking opens the report: UIWindow's motionEnded is exchanged once for one that calls Midge.report() first.
@MainActor enum Shake {
    private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        guard let original = class_getInstanceMethod(UIWindow.self, #selector(UIResponder.motionEnded(_:with:))),
              let replacement = class_getInstanceMethod(UIWindow.self, #selector(UIWindow.midge_motionEnded(_:with:)))
        else { return }
        // UIWindow inherits motionEnded from UIResponder: add it to UIWindow first so UIResponder's isn't swapped.
        if class_addMethod(UIWindow.self, #selector(UIResponder.motionEnded(_:with:)), method_getImplementation(replacement),
                           method_getTypeEncoding(replacement)) {
            class_replaceMethod(UIWindow.self, #selector(UIWindow.midge_motionEnded(_:with:)), method_getImplementation(original),
                                method_getTypeEncoding(original))
        } else {
            method_exchangeImplementations(original, replacement)
        }
    }
}

extension UIWindow {
    @objc func midge_motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake, !(self is PassthroughWindow) {
            MainActor.assumeIsolated { Midge.report() }
        }
        midge_motionEnded(motion, with: event)
    }
}
#endif
