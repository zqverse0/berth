export type TauriTerminalPacket =
  | {
      type: "output"
      sequenceStart: number
      sequenceEnd: number
      data: Uint8Array
    }
  | { type: "resync"; sequence: number }
  | { type: "invalid" }

export type TauriTerminalPacketInput =
  | ArrayBuffer
  | ArrayBufferView
  | ArrayLike<number>

const PACKET_HEADER_BYTES = 20
const PACKET_MAGIC_0 = 0x54
const PACKET_MAGIC_1 = 0x56
const PACKET_VERSION = 2

function asUint8Array(packet: TauriTerminalPacketInput): Uint8Array | null {
  if (packet instanceof ArrayBuffer) return new Uint8Array(packet)
  if (ArrayBuffer.isView(packet)) {
    return new Uint8Array(packet.buffer, packet.byteOffset, packet.byteLength)
  }
  if (
    typeof packet === "object" &&
    packet !== null &&
    typeof (packet as ArrayLike<number>).length === "number"
  ) {
    return Uint8Array.from(packet as ArrayLike<number>)
  }
  return null
}

export function decodeTauriTerminalPacket(
  packet: TauriTerminalPacketInput
): TauriTerminalPacket {
  const bytes = asUint8Array(packet)
  if (!bytes || bytes.byteLength < PACKET_HEADER_BYTES) {
    return { type: "invalid" }
  }
  // DataView needs an ArrayBuffer-backed range; copy when the view is a
  // SharedArrayBuffer window or a non-zero offset slice from Channel fetch.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    view.getUint8(0) !== PACKET_MAGIC_0 ||
    view.getUint8(1) !== PACKET_MAGIC_1 ||
    view.getUint8(2) !== PACKET_VERSION
  ) {
    return { type: "invalid" }
  }
  const kind = view.getUint8(3)
  const sequenceStart = Number(view.getBigUint64(4))
  const sequenceEnd = Number(view.getBigUint64(12))
  if (
    !Number.isSafeInteger(sequenceStart) ||
    !Number.isSafeInteger(sequenceEnd) ||
    sequenceEnd < sequenceStart
  ) {
    return { type: "invalid" }
  }
  if (kind === 1) {
    return {
      type: "output",
      sequenceStart,
      sequenceEnd,
      // Copy payload so later buffer reuse by IPC cannot corrupt xterm writes.
      data: bytes.slice(PACKET_HEADER_BYTES),
    }
  }
  if (kind === 2 && sequenceStart === sequenceEnd) {
    return { type: "resync", sequence: sequenceEnd }
  }
  return { type: "invalid" }
}
