import UIKit

final class TestView: UIView {
  var tick = 0
  var left = 0
  var right = 0
  var moves = 0
  override init(frame: CGRect) {
    super.init(frame: frame)
    isMultipleTouchEnabled = false
    Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      self?.tick += 1
      self?.setNeedsDisplay()
    }
  }
  required init?(coder: NSCoder) { fatalError() }
  override func draw(_ rect: CGRect) {
    let colors: [UIColor] = [.systemBlue, .systemGreen, .systemOrange, .systemPurple]
    colors[tick % colors.count].setFill()
    UIRectFill(bounds)
    for side in 0...1 {
      let x = CGFloat(side) * bounds.width / 2
      let text = "\(side == 0 ? "LEFT" : "RIGHT")\nFRAME \(tick)\nTAPS \(side == 0 ? left : right)\nDRAG \(moves)"
      (text as NSString).draw(in: CGRect(x: x + 30, y: bounds.height * 0.35, width: bounds.width / 2 - 40, height: 250), withAttributes: [.font: UIFont.monospacedSystemFont(ofSize: 27, weight: .bold), .foregroundColor: UIColor.white])
      for (row, value) in [tick, side == 0 ? left : right, moves].enumerated() {
        for bit in 0..<8 {
          ((value >> bit) & 1 == 1 ? UIColor.white : UIColor.black).setFill()
          UIRectFill(CGRect(x: x + bounds.width * (0.05 + CGFloat(bit) * 0.05), y: bounds.height * (0.22 + Double(row) * 0.24), width: bounds.width * 0.04, height: bounds.height * 0.08))
        }
      }
    }
  }
  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let touch = touches.first else { return }
    if touch.location(in: self).x < bounds.width / 2 { left += 1 } else { right += 1 }
    setNeedsDisplay()
  }
  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) { moves += 1; setNeedsDisplay() }
}
final class Controller: UIViewController {
  override func loadView() { view = TestView() }
  override var prefersStatusBarHidden: Bool { true }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .all }
}
final class Scene: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    window = UIWindow(windowScene: scene)
    window?.rootViewController = Controller()
    window?.makeKeyAndVisible()
  }
}
final class Delegate: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let config = UISceneConfiguration(name: "Fixture", sessionRole: session.role)
    config.delegateClass = Scene.self
    return config
  }
}
UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(Delegate.self))
