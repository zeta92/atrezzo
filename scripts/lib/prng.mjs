// Deterministic PRNG. No Math.random(), no clock. Same seed => same sequence.
// Seeds are hashed with xmur3 and fed into sfc32 (fast, good statistical quality).

/** Hash an arbitrary string into a 32-bit seed generator (xmur3). */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function sfc32(a, b, c, d) {
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Create a PRNG. `seed` may be a number or string; `stream` derives an
 * independent sub-sequence (e.g. one per entity) so that adding an entity to
 * the world does not shift the values of the others.
 */
export function createRng(seed, stream = '') {
  const gen = xmur3(`${seed}::${stream}`);
  const next = sfc32(gen(), gen(), gen(), gen());
  // Warm up: discard the first values, sfc32 recommends it.
  for (let i = 0; i < 12; i++) next();

  const rng = {
    /** Float in [0, 1). */
    next,
    /** Integer in [min, max], both inclusive. */
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`rng.int: rango inválido [${min}, ${max}]`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
    pick(arr) {
      if (!arr.length) throw new RangeError('rng.pick: array vacío');
      return arr[Math.floor(next() * arr.length)];
    },
    /** Returns a new shuffled array (Fisher–Yates); the input is not mutated. */
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    /** `k` distinct indices from [0, n), in ascending order. */
    sample(n, k) {
      return rng.shuffle([...Array(n).keys()]).slice(0, k).sort((x, y) => x - y);
    },
    fork(stream2) {
      return createRng(seed, `${stream}/${stream2}`);
    },
  };
  return rng;
}
