declare module "wawoff2" {
  export function decompress(input: Buffer | Uint8Array): Promise<Buffer>;
}
