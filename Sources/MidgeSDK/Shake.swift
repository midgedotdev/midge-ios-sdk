#if os(iOS)
import ObjectiveC
import UIKit

/// Shaking opens the report: UIWindow gets its own motionEnded that calls Midge.report() and then the original one.
///
/// The original is called with its own selector. UIWindow inherits motionEnded from UIResponder, whose implementation
/// passes the event up the responder chain under the selector it was called with; exchanging it for a renamed method
/// made it forward `midge_motionEnded:withEvent:`, which the scene doesn't know, and the app crashed on the first shake.
@MainActor enum Shake {
    private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        let selector = #selector(UIResponder.motionEnded(_:with:))
        guard let method = class_getInstanceMethod(UIWindow.self, selector) else { return }
        typealias MotionEnded = @convention(c) (AnyObject, Selector, UIEvent.EventSubtype, UIEvent?) -> Void
        let original = unsafeBitCast(method_getImplementation(method), to: MotionEnded.self)
        let replacement: @convention(block) (AnyObject, UIEvent.EventSubtype, UIEvent?) -> Void = { window, motion, event in
            if motion == .motionShake, !(window is PassthroughWindow) {
                MainActor.assumeIsolated { Midge.report() }
            }
            original(window, selector, motion, event)
        }
        let implementation = imp_implementationWithBlock(replacement)
        // Inherited: add UIWindow's own, leaving UIResponder's untouched. Already UIWindow's: replace it in place.
        if !class_addMethod(UIWindow.self, selector, implementation, method_getTypeEncoding(method)) {
            method_setImplementation(method, implementation)
        }
    }
}
#endif
