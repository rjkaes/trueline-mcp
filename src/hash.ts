// ==============================================================================
// FNV-1a Hash
// ==============================================================================

export const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

/**
 * Compute FNV-1a 32-bit hash of a string's UTF-8 bytes.
 *
 * FNV-1a is a fast, non-cryptographic hash with good distribution.
 * We use it because the vscode-hashline-edit-tool spec chose
 * it, and matching the spec means interoperability with other tools.
 */
export function fnv1aHash(line: string): number {
  const buf = Buffer.from(line);
  return fnv1aHashBytes(buf, 0, buf.length);
}

/**
 * Compute FNV-1a 32-bit hash directly on raw bytes in a Buffer.
 *
 * Equivalent to `fnv1aHash(str)` when the buffer contains the UTF-8
 * encoding of `str`, but works on any encoding. This is the canonical
 * hash function — both read and edit paths use it to hash raw file bytes,
 * making hashes encoding-independent.
 */
export function fnv1aHashBytes(buf: Buffer, start: number, end: number): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = start; i < end; i++) {
    hash = Math.imul(hash ^ buf[i], FNV_PRIME) >>> 0;
  }
  return hash;
}

/**
 * Fold a 32-bit line hash into a running checksum accumulator.
 *
 * Feeds all 4 bytes of `h` (little-endian) into the FNV-1a accumulator.
 * This is the core building block for streaming checksum computation
 * in `handleRead`.
 */
export function foldHash(accumulator: number, h: number): number {
  accumulator = Math.imul(accumulator ^ (h & 0xff), FNV_PRIME) >>> 0;
  accumulator = Math.imul(accumulator ^ ((h >>> 8) & 0xff), FNV_PRIME) >>> 0;
  accumulator = Math.imul(accumulator ^ ((h >>> 16) & 0xff), FNV_PRIME) >>> 0;
  accumulator = Math.imul(accumulator ^ ((h >>> 24) & 0xff), FNV_PRIME) >>> 0;
  return accumulator;
}

/** 26-char base for checksum encoding. */
const BASE26 = "abcdefghijklmnopqrstuvwxyz";

/** Encode a 32-bit checksum as 6 lowercase letters via base-26. 26^6 = 308M values. */
export function checksumToLetters(h: number): string {
  let result = "";
  let n = h >>> 0;
  for (let i = 0; i < 6; i++) {
    result = BASE26[n % 26] + result;
    n = (n / 26) | 0;
  }
  return result;
}

// 623 pairs, 1246 chars
const HASH_PREFIXES: readonly string[] = (
  "ineronreatstenorleitanaralouisesedicetroaselctndidamomimilurseex" +
  "adchutifemolthigivceodagayotusunulueowewabumpetrckheloapublyavir" +
  "ntpthtoskequizdeopupriplldocogffokclipibacakveppddrrccieprlludte" +
  "awobiasoaxgeftliepboecphugsstpegneioeffoovghrywegrcashixrangtoms" +
  "mlconcysduofypwoeyekwwbsrctdmpwhbrazbeahqlfltnwnikymfrajpsbyufma" +
  "ucpxfeyntyuirgsgdbbleeainospuxxtoylnohmdswrlscmypimtjstatsafooeh" +
  "meruksaudfdozeebmbukijsldapyvoycrtgonaaosvpgsmdrfajeiimmnyfsylpc" +
  "txuyhrxyxxhazylauazacdnskagyoebacplsyyfgltcsskgnhscrevoxgtpmuzaa" +
  "dsporsttjapuktxfcigsaehibbglhonpcmtksimowdrdvapakioigafdihcbvgjo" +
  "vmkgvcnndkdcnijiyakyxbdtrfxcmigibifxfczixewphydijugurmdlfnbcwsnu" +
  "tfbdyesawtkoozgbxasnujxdvtcfdplukrvifiwaeztidyzztcrvklrbfbfpyreq" +
  "lfbncytlvsxiztlguvkubgmgeauhrxdxzobtmccvbfsdlpvytmczdmcnszggvlsr" +
  "muvppdqatwnlpfhdkmyoiyytvdwipbnhhusbsflcdnlmbphlnbmxyztbxswriuvr" +
  "lrknkkoawmnrnmbupneieucuwbznhhfwgcpkmrwxfmlbhpojkbgvmnlvbxgptvrp" +
  "wysysjqrqtuonxiqzhwchnxlmktueozbzucxmvgmqswlsucgqqmqhwfvmfvnsqgd" +
  "kwbmdwvhuupvfydhkhzwfhkclxzmnfrwpwfuqpvvhmvwzcdgejrnxpbjaqnviwhz" +
  "dvtzkddzhcyijjjbbwyubkrhydqizkxozstgfklkjkuwvbxnwfjdkvjljqmwhfgf" +
  "vfwgvujpgzrkvxqnvkkpsxzdyghbnkqbwknzxryxbhmhrzrqljgwbvxmnjlwjthx" +
  "jrqcgxnwcwjclhfqpqwujmpzhgzxwjzlqwzfqvbzykvjyhjhqdqmdjmjqecjkfhq" +
  "hvybywhkdqqxpjqhkjxzzpjncqlzjf" +
  ""
).match(/../g)!;

/**
 * Map an FNV-1a hash to a two-character tag drawn from single-BPE-token
 * bigrams. 623 pairs — every legal `[a-z][a-z]` single-token bigram in
 * cl100k_base — for maximum token economy per tag.
 */
export function hashToLetters(h: number): string {
  // XOR-fold upper and lower 16 bits to decorrelate the two characters.
  // Without this, FNV-1a's adjacent-byte correlation causes clustering.
  const folded = ((h >>> 16) ^ (h & 0xffff)) >>> 0;
  return HASH_PREFIXES[folded % HASH_PREFIXES.length];
}
