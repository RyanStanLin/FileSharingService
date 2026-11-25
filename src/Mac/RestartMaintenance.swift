import Darwin
import Foundation

struct RestartMaintenance: Sendable {
    struct Lease: Codable, Sendable {
        let id: String
        let ticket: String
        let origin: URL
        let boot: String
        let observed: UInt64
        let deadline: UInt64
    }

    static let supported = bootSession != nil
    private static let maximum: UInt64 = 600_000_000_000
    private static let second: UInt64 = 1_000_000_000
    private static let bootSession: String? = {
        var buffer = [CChar](repeating: 0, count: 64)
        var length = buffer.count
        guard sysctlbyname("kern.bootsessionuuid", &buffer, &length, nil, 0) == 0,
              length > 0, length <= buffer.count, buffer[length - 1] == 0 else { return nil }
        let value = String(cString: buffer)
        return UUID(uuidString: value) == nil ? nil : value
    }()

    let directory: URL
    private var marker: URL { directory.appendingPathComponent("restart-maintenance.json") }
    private static var now: UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) }

    func activeLease() -> Lease? {
        guard let lease = read(), let boot = Self.bootSession, lease.boot == boot, Self.validID(lease.id),
              Self.validTicket(lease.ticket), EndpointProfile.origins.contains(lease.origin) else { return nil }
        let now = Self.now
        guard lease.observed <= now, now < lease.deadline, lease.deadline - lease.observed <= Self.maximum else { return nil }
        return lease
    }

    func prepare(_ payload: JSON, from origin: URL) async throws -> Lease {
        guard let boot = Self.bootSession else { throw AgentError("maintenance_state_unavailable") }
        let id = try payload.requireString("leaseId")
        let ticket = try payload.requireString("ticket")
        guard Self.validID(id), Self.validTicket(ticket), EndpointProfile.origins.contains(origin) else {
            throw AgentError("invalid_request")
        }

        let session = AgentHttp.createSession(requestTimeout: 3, resourceTimeout: 3)
        defer { session.invalidateAndCancel() }
        let observed = Self.now
        guard let remaining = await check(id, ticket: ticket, origin: origin, session: session) else {
            throw AgentError("maintenance_ticket_unavailable")
        }
        guard remaining > 0 else { throw AgentError("maintenance_lease_ended") }
        // Start measuring before the request. Network delay can only shorten the pause.
        let deadline = observed + UInt64(remaining) * 1_000_000
        guard deadline > Self.now else { throw AgentError("maintenance_lease_ended") }
        return Lease(id: id, ticket: ticket, origin: origin, boot: boot, observed: observed, deadline: deadline)
    }

    func arm(_ lease: Lease) throws {
        try Task.checkCancellation()
        guard lease.deadline > Self.now else { throw AgentError("maintenance_lease_ended") }
        do {
            try locked {
                let data = try JSONEncoder().encode(lease)
                try data.write(to: marker, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: marker.path)
            }
        } catch {
            throw AgentError("maintenance_state_unavailable")
        }
    }

    func waitForRelease(_ lease: Lease) async {
        let poller = Task { await poll(lease) }
        defer { poller.cancel() }

        // The local deadline runs independently of URLSession, including when the server is unreachable.
        while !Task.isCancelled, activeLease()?.id == lease.id {
            let now = Self.now
            guard lease.deadline > now else { break }
            do { try await Task.sleep(for: .nanoseconds(Int64(min(Self.second, lease.deadline - now)))) }
            catch { return }
        }
        if Self.now >= lease.deadline { try? remove(lease) }
    }

    private func poll(_ lease: Lease) async {
        let session = AgentHttp.createSession(requestTimeout: 3, resourceTimeout: 3)
        defer { session.invalidateAndCancel() }
        while !Task.isCancelled, Self.now < lease.deadline {
            if await check(lease.id, ticket: lease.ticket, origin: lease.origin, session: session) == 0,
               !Task.isCancelled {
                do {
                    try remove(lease)
                    return
                } catch {}
            }
            do { try await Task.sleep(for: .seconds(3)) }
            catch { return }
        }
    }

    private func check(_ id: String, ticket: String, origin: URL, session: URLSession) async -> Int64? {
        let url = origin.appendingPathComponent("agent/v1/maintenance/\(id)")
        var request = URLRequest(url: url, timeoutInterval: 3)
        request.setValue(ticket, forHTTPHeaderField: "X-FileSharing-Maintenance")
        guard let (data, response) = try? await session.data(for: request), data.count <= 4096,
              let status = (response as? HTTPURLResponse)?.statusCode,
              let value = try? JSON.decode(data) else { return nil }

        if status == 404 && value["code"].string == "maintenance_ticket_not_found" { return 0 }
        guard status == 200, let remaining = value["remainingMilliseconds"].int, (0...600_000).contains(remaining)
        else { return nil }
        return remaining
    }

    private func read() -> Lease? {
        let descriptor = open(marker.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { return nil }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0, (1...2048).contains(info.st_size),
              let data = try? file.read(upToCount: 2049), data.count <= 2048 else { return nil }
        return try? JSONDecoder().decode(Lease.self, from: data)
    }

    private func remove(_ lease: Lease) throws {
        try locked {
            if read()?.id == lease.id { try FileManager.default.removeItem(at: marker) }
        }
    }

    private func locked(_ change: () throws -> Void) throws {
        let path = directory.appendingPathComponent("restart-maintenance.lock")
        let descriptor = open(path.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw AgentError("maintenance_state_unavailable") }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else { throw AgentError("maintenance_state_unavailable") }
        try change()
    }

    private static func validID(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }

    private static func validTicket(_ value: String) -> Bool {
        value.utf8.count == 43 && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }
}
