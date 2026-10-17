// Sip 的鼠标小助手：只看鼠标（不看键盘），告诉 Sip 鼠标在哪、有没有在桌面上按下。
// 输出一行一个 JSON：
//   {"t":"move"|"drag","x":..,"y":..,"desk":true|false}
//   {"t":"down","x":..,"y":..,"desk":..}   {"t":"up","x":..,"y":..}
// desk = 这个位置上面没有任何窗口（看得到桌面和水）。
// 坐标：主屏左上角为原点，单位 point，和 Electron 的 screen 坐标一致。

import Cocoa

setvbuf(stdout, nil, _IOLBF, 0)

let parentPid = getppid()

func primaryHeight() -> CGFloat {
  return NSScreen.screens.first?.frame.height ?? 0
}

func cursor() -> CGPoint {
  let p = NSEvent.mouseLocation
  return CGPoint(x: p.x, y: primaryHeight() - p.y)
}

var cachedAt: TimeInterval = 0
var cached: [[String: Any]] = []

func windowList(fresh: Bool) -> [[String: Any]] {
  let now = ProcessInfo.processInfo.systemUptime
  if fresh || now - cachedAt > 0.25 {
    cached = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
    cachedAt = now
  }
  return cached
}

var dockPid: Int32 = -1
func isDock(_ pid: Int32) -> Bool {
  if dockPid < 0 {
    dockPid = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first?.processIdentifier ?? 0
  }
  return pid == dockPid
}

func coversScreen(_ r: CGRect) -> Bool {
  let h = primaryHeight()
  for s in NSScreen.screens {
    let f = CGRect(x: s.frame.minX, y: h - s.frame.maxY, width: s.frame.width, height: s.frame.height)
    if r.width >= f.width * 0.95 && r.height >= f.height * 0.95 && r.intersects(f) { return true }
  }
  return false
}

func overDesktop(_ p: CGPoint, fresh: Bool) -> Bool {
  for w in windowList(fresh: fresh) {
    let layer = w[kCGWindowLayer as String] as? Int ?? 0
    if layer < 0 { continue }                                    // 桌面层的东西
    let pid = w[kCGWindowOwnerPID as String] as? Int32 ?? 0
    if pid == parentPid { continue }                             // Sip 自己的窗口
    let alpha = w[kCGWindowAlpha as String] as? Double ?? 1
    if alpha < 0.01 { continue }
    guard let dict = w[kCGWindowBounds as String] as? NSDictionary,
          let r = CGRect(dictionaryRepresentation: dict) else { continue }
    // Dock、系统浮层这类铺满整屏的透明窗口不算挡住桌面（普通 App 全屏窗口是第 0 层，照样算）
    // （菜单栏和 Dock 区域由 Sip 主进程自己排除）
    if layer > 0, coversScreen(r) { continue }
    if isDock(pid) { continue }
    if r.contains(p) { return false }
  }
  return true
}

func emit(_ t: String, _ p: CGPoint, desk: Bool?) {
  var s = "{\"t\":\"\(t)\",\"x\":\(Int(p.x.rounded())),\"y\":\(Int(p.y.rounded()))"
  if let d = desk { s += ",\"desk\":\(d)" }
  print(s + "}")
}

var lastMove: TimeInterval = 0

NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { e in
  let now = ProcessInfo.processInfo.systemUptime
  if now - lastMove < 1.0 / 60.0 { return }
  lastMove = now
  let p = cursor()
  emit(e.type == .leftMouseDragged ? "drag" : "move", p, desk: overDesktop(p, fresh: false))
}

NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { _ in
  let p = cursor()
  emit("down", p, desk: overDesktop(p, fresh: true))
}

NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseUp]) { _ in
  emit("up", cursor(), desk: nil)
}

// Sip 退出了，小助手也跟着退出
Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
  if getppid() != parentPid { exit(0) }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.run()
