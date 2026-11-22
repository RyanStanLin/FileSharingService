import AppKit
import CoreGraphics

@MainActor
final class WindowMonitor {
    private static let queue = DispatchQueue(label: "FileSharing.windows", qos: .utility)
    private var lease: (id: String, expiry: ContinuousClock.Instant)?
    private var sampler: Task<Void, Never>?

    func observe(_ id: String, seconds: Int64, canSample: @escaping () -> Bool,
                 report: @escaping (String, JSON) async -> Void) {
        let expiry = ContinuousClock.now + .seconds(seconds)
        if lease?.id == id {
            lease?.expiry = expiry
            return
        }
        sampler?.cancel()
        lease = (id, expiry)
        sampler = Task {
            var previous: JSON?
            while !Task.isCancelled, let current = lease, current.id == id, current.expiry > .now {
                let sample: JSON
                if canSample() {
                    let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
                    let observed = await Self.read(frontmost: frontmost)
                    sample = canSample() ? observed : WindowInventory.unavailable
                } else {
                    sample = WindowInventory.unavailable
                }
                guard !Task.isCancelled, lease?.id == id else { return }
                if previous != sample {
                    previous = sample
                    await report(id, sample)
                }
                try? await Task.sleep(for: .milliseconds(250))
            }
            if !Task.isCancelled, lease?.id == id {
                lease = nil
                sampler = nil
            }
        }
    }

    func stop(_ id: String) {
        guard lease?.id == id else { return }
        lease = nil
        sampler?.cancel()
        sampler = nil
    }

    private static func read(frontmost: pid_t?) async -> JSON {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: WindowInventory.read(frontmost: frontmost)) }
        }
    }
}

private enum WindowInventory {
    private struct Window {
        let id: UInt32
        let pid: pid_t
        let owner: String?
        let layer: Int
        let alpha: Double
        let bounds: CGRect
    }

    private struct Display {
        let id: UInt32
        let main: Bool
        let bounds: CGRect

        var json: JSON { ["id": .integer(Int64(id)), "main": .boolean(main), "bounds": WindowInventory.geometry(bounds)] }
    }

    private static let maximumWindows = 1024
    private static let maximumDisplays = 32

    static let unavailable: JSON = ["available": false, "displays": [], "activePid": .null, "focusStatus": "unavailable",
                                     "focusedWindowId": .null, "windows": [], "truncated": false]

    static func read(frontmost: pid_t?) -> JSON {
        #if FILESHARING_TEST
        if let fixture = ProcessInfo.processInfo.environment["FILESHARING_TEST_WINDOW_STATE"] {
            return readFixture(fixture)
        }
        #endif
        if let session = CGSessionCopyCurrentDictionary() as? [String: Any],
           session[kCGSessionOnConsoleKey as String] as? Bool == false { return unavailable }
        guard let onscreen = readWindows(.optionOnScreenOnly), let all = readWindows(.optionAll) else { return unavailable }
        return describe(onscreen: onscreen, all: all, displays: activeDisplays(), frontmost: frontmost)
    }

    private static func readWindows(_ option: CGWindowListOption) -> [Window]? {
        guard let rows = CGWindowListCopyWindowInfo(option, kCGNullWindowID) as? [[String: Any]] else { return nil }
        return rows.compactMap { row in
            guard let id = row[kCGWindowNumber as String] as? NSNumber, id.uint32Value > 0,
                  let pid = row[kCGWindowOwnerPID as String] as? NSNumber,
                  let layer = row[kCGWindowLayer as String] as? NSNumber,
                  let alpha = row[kCGWindowAlpha as String] as? NSNumber,
                  alpha.doubleValue.isFinite,
                  let serialized = row[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: serialized as CFDictionary),
                  valid(bounds) else { return nil }
            let owner = (row[kCGWindowOwnerName as String] as? String).map { String(decoding: $0.utf8.prefix(192), as: UTF8.self) }
            return Window(id: id.uint32Value, pid: pid.int32Value, owner: owner, layer: layer.intValue,
                          alpha: min(1, max(0, alpha.doubleValue)), bounds: bounds)
        }
    }

    private static func activeDisplays() -> [Display] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        let main = CGMainDisplayID()
        return ids.prefix(Int(count)).sorted().compactMap { id in
            let bounds = CGDisplayBounds(id)
            return valid(bounds) && !bounds.isEmpty ? Display(id: id, main: id == main, bounds: bounds) : nil
        }
    }

    private static func describe(onscreen: [Window], all: [Window], displays: [Display], frontmost: pid_t?) -> JSON {
        var ids = Set<UInt32>()
        let ordered = onscreen.filter { ids.insert($0.id).inserted }
        let outside = all.filter { ids.insert($0.id).inserted }.sorted { $0.id < $1.id }
        let screens = Array(displays.prefix(maximumDisplays))
        let visible = Array(ordered.prefix(maximumWindows))
        let onDisplay = visible.filter { window in
            window.alpha > 0 && screens.contains { area($0.bounds.intersection(window.bounds)) > 0 }
        }
        let top = onDisplay.first?.id
        let focusedId = onDisplay.first { $0.pid == frontmost }?.id
        let values = (visible + outside.prefix(maximumWindows - visible.count)).enumerated().map { index, window -> JSON in
            let onScreen = index < visible.count
            let display = primaryDisplay(for: window.bounds, displays: screens)
            return [
                "id": .integer(Int64(window.id)), "pid": .integer(Int64(window.pid)), "ownerName": .text(window.owner),
                "layer": .number(window.layer), "alpha": .decimal(window.alpha), "bounds": geometry(window.bounds),
                "displayId": .number(display.map { Int($0.id) }),
                "relativeBounds": display.map { geometry(window.bounds.offsetBy(dx: -$0.bounds.minX, dy: -$0.bounds.minY)) } ?? .null,
                "onScreen": .boolean(onScreen), "zIndex": .number(onScreen ? index : nil), "frontmost": .boolean(top == window.id),
                "ownerFrontmost": .boolean(window.pid == frontmost),
                "focused": .boolean(focusedId == window.id),
                "occlusion": coverage(of: window, displayed: onScreen, above: visible.prefix(min(visible.count, index)), screens: screens)
            ]
        }
        return ["available": true, "displays": .array(screens.map(\.json)), "activePid": .number(frontmost.map(Int.init)),
                "focusStatus": focusedId == nil ? "noFocusedWindow" : "foreground",
                "focusedWindowId": .number(focusedId.map(Int.init)), "windows": .array(values),
                "truncated": .boolean(ids.count > maximumWindows || displays.count > maximumDisplays)]
    }

    private static func primaryDisplay(for bounds: CGRect, displays: [Display]) -> Display? {
        var best: Display?
        var largest: CGFloat = 0
        for display in displays {
            let size = area(bounds.intersection(display.bounds))
            if size > largest || (size == largest && size > 0 && display.main) {
                best = display
                largest = size
            }
        }
        return best
    }

    private static func coverage(of window: Window, displayed: Bool, above: ArraySlice<Window>, screens: [Display]) -> JSON {
        guard displayed, window.alpha > 0 else { return occlusion("notDisplayed", fraction: nil) }
        guard !screens.isEmpty else { return occlusion("unknown", fraction: nil) }
        var visible: [CGRect] = []
        for screen in screens {
            let clip = window.bounds.intersection(screen.bounds)
            guard area(clip) > 0 else { continue }
            // A mirrored display may share the same coordinates as another display.
            visible += visible.reduce([clip]) { pending, rect in pending.flatMap { subtract($0, by: rect) } }
        }
        let total = visible.reduce(0) { $0 + area($1) }
        guard total > 0 else { return occlusion("notDisplayed", fraction: nil) }
        var blockers: [JSON] = []
        for other in above where other.alpha == 1 && other.bounds.intersects(window.bounds) {
            guard visible.contains(where: { area($0.intersection(other.bounds)) > 0 }) else { continue }
            if blockers.count < 16 { blockers.append(.integer(Int64(other.id))) }
            visible = visible.flatMap { subtract($0, by: other.bounds) }
            if visible.isEmpty { return occlusion("covered", fraction: 1, blockers) }
            if visible.count > 512 { return occlusion("unknown", fraction: nil, blockers) }
        }
        let fraction = min(1, max(0, 1 - visible.reduce(0) { $0 + area($1) } / total))
        return occlusion(blockers.isEmpty ? "visible" : "partial", fraction: Double(fraction), blockers)
    }

    private static func subtract(_ rect: CGRect, by covered: CGRect) -> [CGRect] {
        let clip = rect.intersection(covered)
        guard area(clip) > 0 else { return [rect] }
        return [
            CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: clip.minY - rect.minY),
            CGRect(x: rect.minX, y: clip.maxY, width: rect.width, height: rect.maxY - clip.maxY),
            CGRect(x: rect.minX, y: clip.minY, width: clip.minX - rect.minX, height: clip.height),
            CGRect(x: clip.maxX, y: clip.minY, width: rect.maxX - clip.maxX, height: clip.height)
        ].filter { !$0.isEmpty }
    }

    private static func valid(_ rectangle: CGRect) -> Bool {
        [rectangle.origin.x, rectangle.origin.y, rectangle.width, rectangle.height].allSatisfy(\.isFinite) &&
            rectangle.size.width >= 0 && rectangle.size.height >= 0
    }

    private static func area(_ rect: CGRect) -> CGFloat { rect.isEmpty ? 0 : rect.width * rect.height }

    private static func geometry(_ rect: CGRect) -> JSON {
        ["x": .decimal(rect.minX), "y": .decimal(rect.minY), "width": .decimal(rect.width), "height": .decimal(rect.height)]
    }

    private static func occlusion(_ state: String, fraction: Double?, _ ids: [JSON] = []) -> JSON {
        ["state": .string(state), "coveredFraction": fraction.map(JSON.decimal) ?? .null, "occludingWindowIds": .array(ids)]
    }

    #if FILESHARING_TEST
    private static func readFixture(_ path: String) -> JSON {
        guard let bytes = try? Data(contentsOf: URL(fileURLWithPath: path)), let source = try? JSON.decode(bytes)
        else { return unavailable }

        func number(_ value: JSON) -> Double? {
            if case .decimal(let raw) = value { return raw }
            return value.int.map(Double.init)
        }
        func rect(_ value: JSON) -> CGRect? {
            let values = ["x", "y", "width", "height"].compactMap { number(value[$0]) }
            guard values.count == 4 else { return nil }
            return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
        }
        let windows = (source["windows"].array ?? []).compactMap { row -> Window? in
            guard let id = row["id"].int.flatMap(UInt32.init(exactly:)),
                  let pid = row["pid"].int.flatMap(pid_t.init(exactly:)), let bounds = rect(row["bounds"]) else { return nil }
            return Window(id: id, pid: pid, owner: row["ownerName"].string, layer: Int(row["layer"].int ?? 0),
                          alpha: number(row["alpha"]) ?? 1, bounds: bounds)
        }
        let displays = (source["displays"].array ?? []).compactMap { row -> Display? in
            guard let id = row["id"].int.flatMap(UInt32.init(exactly:)), let bounds = rect(row["bounds"]) else { return nil }
            return Display(id: id, main: row["main"].bool == true, bounds: bounds)
        }
        let visibleIds = Set((source["onScreen"].array ?? []).compactMap(\.int))
        return describe(onscreen: windows.filter { visibleIds.contains(Int64($0.id)) }, all: windows, displays: displays,
                        frontmost: source["activePid"].int.flatMap(pid_t.init(exactly:)))
    }
    #endif
}
