import { PNG } from 'pngjs'

/**
 * Make a plain light background transparent. Starting from the image edges, flood-fill every pixel
 * close to the background colour; pixels inside a shape are never reached, so solid areas keep no
 * holes (image models' own "transparent" mode tends to punch holes in flat fills). Edges are
 * softened so anti-aliasing doesn't leave a white halo.
 */
export function keyOutBackground(input: Buffer, tolerance = 28, feather = 40): Buffer {
  const png = PNG.sync.read(input)
  const { width: w, height: h, data } = png
  // Background colour: the median of the four corners
  const corner = (x: number, y: number) => { const i = (y * w + x) * 4; return [data[i]!, data[i + 1]!, data[i + 2]!] }
  const cs = [corner(0, 0), corner(w - 1, 0), corner(0, h - 1), corner(w - 1, h - 1)]
  const bg = [0, 1, 2].map(k => cs.map(c => c[k]!).sort((a, b) => a - b)[1]!)
  const dist = (i: number) => Math.max(Math.abs(data[i]! - bg[0]!), Math.abs(data[i + 1]! - bg[1]!), Math.abs(data[i + 2]! - bg[2]!))

  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (x: number, y: number) => { const p = y * w + x; if (!seen[p]) { seen[p] = 1; stack.push(p) } }
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1) }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y) }
  while (stack.length) {
    const p = stack.pop()!
    const i = p * 4
    const d = dist(i)
    if (d > tolerance + feather) continue // reached the shape
    // Fully transparent inside the tolerance, a soft ramp across the feather band
    const a = d <= tolerance ? 0 : Math.round(((d - tolerance) / feather) * 255)
    data[i + 3] = Math.min(data[i + 3]!, a)
    if (d > tolerance) continue // the edge band itself doesn't spread the fill
    const x = p % w, y = (p - x) / w
    if (x > 0) push(x - 1, y)
    if (x < w - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < h - 1) push(x, y + 1)
  }
  return PNG.sync.write(png)
}
