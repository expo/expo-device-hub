import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let window = UIWindow(frame: UIScreen.main.bounds)
    let viewController = UIViewController()
    viewController.view.backgroundColor = .systemBackground

    let label = UILabel(frame: CGRect(x: 24, y: 120, width: 340, height: 80))
    label.text = "serve-sim crash E2E"
    viewController.view.addSubview(label)

    window.rootViewController = viewController
    window.makeKeyAndVisible()
    self.window = window

    NSLog("SERVE_SIM_CRASH_FIXTURE_MARKER")
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
      crashFixtureAbort()
    }
    return true
  }
}
