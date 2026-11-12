// The companion: a small artichoke (a nod to the Coeurdar logo) drawn in half blocks, 16 columns by 9 rows, tinted by the
// mood. Pure functions, no engine call: a pixel grid in, rows of styled runs out. The character is original; the idea of a
// figure that tells you when the agent needs you was inspired by Coucou (MIT), whose character is not used here.
import type { Mood } from './mood'

export const SPRITE_COLUMNS = 16
export const SPRITE_ROWS = 9

/** One cell: a half block, its colour the top pixel and its background the bottom one (▄ when only the bottom is lit). */
export type Cell = { char: ' ' | '▀' | '▄'; color?: string; backgroundColor?: string }
export type Run = { text: string; color?: string; backgroundColor?: string }

/** Tones of each mood (L light, G green-ish body, M mid, D dark outline) and the colours every mood shares (W white, K black, P pink). */
const TINT: Record<Mood, Record<string, string>> = {
  work: { L: '#b9d3ff', G: '#6f95d8', M: '#4f72b3', D: '#22335a' },
  wait: { L: '#f7dca0', G: '#dba24a', M: '#b07a25', D: '#553a10' },
  done: { L: '#c2e8a8', G: '#79b866', M: '#4f8f45', D: '#1f3d22' },
  error: { L: '#f6b3b8', G: '#d86671', M: '#a8424e', D: '#4f1c23' },
  idle: { L: '#b4bac4', G: '#7a818e', M: '#5a606b', D: '#2a2e36' },
}
const FIXED: Record<string, string> = { W: '#f6f4ec', K: '#101216', P: '#f29aa6' }

/**
 * The frames of each mood: 18 pixel rows of 16, joined by "/", '.' transparent. work: lift 0, lift 1, lift 1 glancing, lift 0
 * glancing; wait: still, then a raised leaf and a lift. The others do not move.
 */
const FRAMES: Record<Mood, string[]> = {
  work: [
    '.......DD......./.......GG......./....DDDGGDDD..../....MLDGGDLM..../..DDMMDGGDMMDD../..DDDDGDDGDDDD../.DDLDGGDDGDDLDD./DMDGDDLGGGDDGDMD/DMLDLLLGGGGGDLMD/DDDGGWGGGGWGGDDD/MMDGGKGGGGKGGDMM/MMDGGGGGGGGGGDMM/DDDPDDDDDGDDPDDD/...DMLDKKDLMD.../...DDDDDDDDDD.../.....DMDMMD...../.....DDDDDD...../......DDDD......',
    '.......GG......./....DDDGGDDD..../....MLDGGDLM..../..DDMMDGGDMMDD../..DDDDGDDGDDDD../.DDLDGGDDGDDLDD./DMDGDDLGGGDDGDMD/DMLDLLLGGGGGDLMD/DDDGGWGGGGWGGDDD/MMDGGKGGGGKGGDMM/MMDGGGGGGGGGGDMM/DDDPDDDDDGDDPDDD/...DMLDKKDLMD.../...DDDDDDDDDD.../.....DMDMMD...../.....DDDDDD...../.......DD......./.....D....D.....',
    '.......GG......./....DDDGGDDD..../....MLDGGDLM..../..DDMMDGGDMMDD../..DDDDGDDGDDDD../.DDLDGGDDGDDLDD./DMDGDDLGGGDDGDMD/DMLDLLLGGGGGDLMD/DDDGGKGGGGKGGDDD/MMDGGWGGGGWGGDMM/MMDGGGGGGGGGGDMM/DDDPDDDDDGDDPDDD/...DMLDKKDLMD.../...DDDDDDDDDD.../.....DMDMMD...../.....DDDDDD...../.......DD......./.....D....D.....',
    '.......DD......./.......GG......./....DDDGGDDD..../....MLDGGDLM..../..DDMMDGGDMMDD../..DDDDGDDGDDDD../.DDLDGGDDGDDLDD./DMDGDDLGGGDDGDMD/DMLDLLLGGGGGDLMD/DDDGGKGGGGKGGDDD/MMDGGWGGGGWGGDMM/MMDGGGGGGGGGGDMM/DDDPDDDDDGDDPDDD/...DMLDKKDLMD.../...DDDDDDDDDD.../.....DMDMMD...../.....DDDDDD...../......DDDD......',
  ],
  wait: [
    '.......DD......./.......GG......./....DDDGGDDD..../....MLDGGDLM..../..DDMMDGGDMMDD../..DDDDGDDGDDDDDG/.DDLDGGDDGDDLDLG/DMDGDDLGGGDDGDGD/DMLDLLLGGGGGDDDD/DDDGWWGGGGWWGDDD/MMDGWKGGGGKWGDMM/MMDGGGGGGGGGGDMM/DDDPDDDKKGDDPDDD/...DMLDKKDLMD.../...DDDDDDDDDD.../.....DMDMMD...../.....DDDDDD...../......DDDD......',
    '.......GG......./....DDDGGDDD..../....MLDGGDLM..../..DDMMDGGDMMDD../..DDDDGDDGDDDD.D/.DDLDGGDDGDDLDGG/DMDGDDLGGGDDGDGG/DMLDLLLGGGGGDDDD/DDDGWWGGGGWWGDDD/MMDGWKGGGGKWGDMM/MMDGGGGGGGGGGDMM/DDDPDDDKKGDDPDDD/...DMLDKKDLMD.../...DDDDDDDDDD.../.....DMDMMD...../.....DDDDDD...../.......DD......./......D..D......',
  ],
  done: [
    '.......DD......./.......GG......./....DDDGGDDD..../....MLDGGDLM..../..DDMMDGGDMMDD../..DGDDGDDGDDGD../.DDLDGGDDGDDLDD./DMDGDDLGGGDDGDMD/DMLDLLLGGGGGDLMD/DDDGGKGGGGKGGDDD/MMDGKGKGGKGKGDMM/MMDGGGGGGGGGGDMM/DDDPDDKDDKDDPDDD/...DMLDKKDLMD.../...DDDDDDDDDD.../.....DMDMMD...../.....DDDDDD...../......DDDD......',
  ],
  error: [
    '.......DD......./.......GG......./....DDDGGDDD..../....MLDGGDLM..../..DDMMDGGDMMDD../..DDDDGDDGDDDD../.DDLDGGDDGDDLDD./DMDGDDLGGGDDGDMD/DMLDLLLGGGGGDLMD/DDDGWGWGGWGWGDDD/MMDGGWGGGGWGGDMM/MMDGWGWGGWGWGDMM/DDDGDDGKDKDDGDDD/...DMLKMKDLMD.../...DDDDDDDDDD.../.....DMDMMD...../.....DDDDDD...../......DDDD......',
  ],
  idle: [
    '.......DD......./.......GG......./....DDDGGDDD..../....MLDGGDLM..../..DDMMDGGDMMDD../..DMDDGDDGDDMD../..DLDGGDDGDDLD../DDDGDDLGGGDDGDDD/MLMDLLLGGGGGDMLM/DMDGGGGGGGGGGDMD/DDDGKKGGGGKKGDMD/MMDGGGGGGGGGGDMM/MMMGDDGDDGDDGMMM/DDDDMLDKKDLMDDDD/...DDDDDDDDDD.../.....DMDMMD...../.....DDDDDD...../......DDDD......',
  ],
}

const pixel = (mood: Mood, ch: string | undefined): string | undefined => (ch === undefined || ch === '.' ? undefined : (FIXED[ch] ?? TINT[mood][ch]))

/** 9 rows of 16 cells (`tick` picks the frame, the mood's frames in turn): each cell joins two pixel rows, the top one as the colour, the bottom one as the background. */
export function spriteCells(mood: Mood, tick: number): Cell[][] {
  const list = FRAMES[mood]
  const grid = (list[((tick % list.length) + list.length) % list.length] ?? '').split('/')
  return Array.from({ length: SPRITE_ROWS }, (_, r) =>
    Array.from({ length: SPRITE_COLUMNS }, (_, c): Cell => {
      const top = pixel(mood, grid[2 * r]?.[c])
      const bottom = pixel(mood, grid[2 * r + 1]?.[c])
      if (top && bottom) return { char: '▀', color: top, backgroundColor: bottom }
      if (top) return { char: '▀', color: top }
      if (bottom) return { char: '▄', color: bottom }
      return { char: ' ' }
    }),
  )
}

/** The same rows with neighbouring cells of one style merged: a few elements per row instead of sixteen. */
export function spriteRuns(mood: Mood, tick: number): Run[][] {
  return spriteCells(mood, tick).map(row =>
    row.reduce<Run[]>((runs, cell) => {
      const last = runs[runs.length - 1]
      if (last && last.color === cell.color && last.backgroundColor === cell.backgroundColor) return [...runs.slice(0, -1), { ...last, text: last.text + cell.char }]
      return [...runs, { text: cell.char, color: cell.color, backgroundColor: cell.backgroundColor }]
    }, []),
  )
}
