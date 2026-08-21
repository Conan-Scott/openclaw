import { normalizeTalkTransport } from "../../../../src/talk/talk-session-controller.js";
import { GatewayRelayRealtimeTalkTransport } from "./realtime-talk-gateway-relay.ts";
import { GoogleLiveRealtimeTalkTransport } from "./realtime-talk-google-live.ts";
import type {
  RealtimeTalkGatewayRelaySessionResult,
  RealtimeTalkJsonPcmWebSocketSessionResult,
  RealtimeTalkSessionResult,
  RealtimeTalkTransport,
  RealtimeTalkTransportContext,
  RealtimeTalkWebRtcSdpSessionResult,
} from "./realtime-talk-shared.ts";
import { WebRtcSdpRealtimeTalkTransport } from "./realtime-talk-webrtc.ts";

export function resolveRealtimeTalkTransport(session: RealtimeTalkSessionResult): string {
  // SAFETY: every Talk session result may carry the optional wire transport discriminator.
  return normalizeTalkTransport((session as { transport?: string }).transport) ?? "webrtc";
}

export function createRealtimeTalkTransport(
  session: RealtimeTalkSessionResult,
  ctx: RealtimeTalkTransportContext,
): RealtimeTalkTransport {
  const transport = resolveRealtimeTalkTransport(session);
  if (transport === "webrtc") {
    // SAFETY: transport resolution above selects the WebRTC result variant.
    return new WebRtcSdpRealtimeTalkTransport(session as RealtimeTalkWebRtcSdpSessionResult, ctx);
  }
  if (transport === "provider-websocket") {
    return new GoogleLiveRealtimeTalkTransport(
      // SAFETY: transport resolution above selects the provider-WebSocket result variant.
      session as RealtimeTalkJsonPcmWebSocketSessionResult,
      ctx,
    );
  }
  if (transport === "gateway-relay") {
    return new GatewayRelayRealtimeTalkTransport(
      // SAFETY: transport resolution above selects the Gateway-relay result variant.
      session as RealtimeTalkGatewayRelaySessionResult,
      ctx,
    );
  }
  // SAFETY: all result variants may carry the optional raw transport for diagnostics.
  const unknownTransport = (session as { transport?: string }).transport ?? "unknown";
  throw new Error(`Unsupported realtime Talk transport: ${unknownTransport}`);
}
