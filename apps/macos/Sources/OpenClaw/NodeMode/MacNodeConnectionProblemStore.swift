import Foundation
import Observation
import OpenClawKit
import OSLog

@MainActor
@Observable
final class MacNodeConnectionProblemStore {
    static let shared = MacNodeConnectionProblemStore()

    private let logger = Logger(subsystem: "ai.openclaw", category: "mac-node")

    private(set) var problem: GatewayConnectionProblem?
    private(set) var statusMessage: String?

    private init() {}

    func clear() {
        self.problem = nil
        self.statusMessage = nil
    }

    func record(error: Error) {
        guard let nextProblem = GatewayConnectionProblemMapper.map(error: error, preserving: self.problem) else {
            return
        }
        self.problem = nextProblem
        self.statusMessage = nextProblem.statusText
    }

    @discardableResult
    func trustRotatedGatewayCertificate() async -> Bool {
        guard let problem = self.problem,
              problem.canTrustRotatedCertificate,
              let stableID = problem.tlsStoreKey,
              let fingerprint = problem.tlsObservedFingerprint
        else {
            self.statusMessage = "Certificate review required"
            return false
        }

        guard GatewayTLSStore.replaceFingerprint(fingerprint, stableID: stableID) else {
            self.statusMessage = "Could not update gateway certificate"
            return false
        }

        self.logger.info(
            "gateway TLS pin replaced stableID=\(stableID, privacy: .public) " +
                "old=\(problem.tlsExpectedFingerprint ?? "unknown", privacy: .public) " +
                "new=\(fingerprint, privacy: .public)")
        self.problem = nil
        self.statusMessage = "Gateway certificate updated. Reconnecting..."
        // Rebuild the node loop so the next websocket uses fresh TLS pinning params.
        await MacNodeModeCoordinator.shared.reconnect()
        return true
    }
}
