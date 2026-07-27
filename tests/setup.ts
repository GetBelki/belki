import "@testing-library/jest-dom/vitest";

// Cloudflare Workers exposes this Web Crypto extension, while jsdom's
// Node-backed SubtleCrypto does not.
type SubtleCryptoWithTimingSafeEqual = SubtleCrypto & {
  timingSafeEqual?(
    left: ArrayBuffer | ArrayBufferView,
    right: ArrayBuffer | ArrayBufferView,
  ): boolean;
};

const subtleCrypto = crypto.subtle as SubtleCryptoWithTimingSafeEqual;

if (!subtleCrypto.timingSafeEqual) {
  Object.defineProperty(subtleCrypto, "timingSafeEqual", {
    configurable: true,
    value(
      left: ArrayBuffer | ArrayBufferView,
      right: ArrayBuffer | ArrayBufferView,
    ): boolean {
      const leftBytes = ArrayBuffer.isView(left)
        ? new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
        : new Uint8Array(left);
      const rightBytes = ArrayBuffer.isView(right)
        ? new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
        : new Uint8Array(right);
      if (leftBytes.byteLength !== rightBytes.byteLength) return false;

      let difference = 0;
      for (let index = 0; index < leftBytes.byteLength; index += 1) {
        difference |= leftBytes[index]! ^ rightBytes[index]!;
      }
      return difference === 0;
    },
  });
}
