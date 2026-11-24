import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NSLog("SERVE_SIM_CRASH_FIXTURE_MARKER")
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
      crashFixtureAbort()
    }
    return true
  }

  // Apps linked with the iOS 27 SDK must adopt the scene lifecycle, or UIKit stops them at launch.
  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: windowScene)
    let viewController = UIViewController()
    viewController.view.backgroundColor = .systemBackground

    let label = UILabel(frame: CGRect(x: 24, y: 120, width: 340, height: 80))
    label.text = "serve-sim crash E2E"
    viewController.view.addSubview(label)

    window.rootViewController = viewController
    window.makeKeyAndVisible()
    self.window = window
  }
}
