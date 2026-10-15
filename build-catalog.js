// Builds catalog.json from TMDB. No dependencies, needs Node 18+.
// Usage: TMDB_API_KEY=xxx node build-catalog.js
const fs = require('fs')
const path = require('path')

const KEY = process.env.TMDB_API_KEY
if (!KEY) { console.error('Missing TMDB_API_KEY'); process.exit(1) }

const CACHE_FILE = path.join(__dirname, 'tmdb-cache.json')
const OUT_FILE = path.join(__dirname, 'catalog.json')
const DAY = 86400000

// Checked in order: the first match wins.
const CATEGORIES = [
  { id: 'halloween', name: 'Hallmark • Halloween & Fall Fright', re: /halloween|haunt|ghost|witch|pumpkin|spooky|trick.or.treat/i },
  { id: 'christmas', name: 'Hallmark • Christmas', re: /christmas|santa|xmas|noel|holiday|yuletide|reindeer|snow(?:flake|man)|winter wonder|advent|north pole|nutcracker|mistletoe|ornament/i },
  { id: 'valentines', name: "Hallmark • Valentine's & Romance", re: /valentine|cupid|sweetheart|love is|wedding|bride|proposal|romance/i },
  { id: 'spring', name: 'Hallmark • Spring & Easter', re: /easter|spring|blossom|garden|bunny|tulip|mother'?s day/i },
  { id: 'summer', name: 'Hallmark • Summer', re: /summer|beach|lake|sunset|fourth of july|july 4|vacation|camp|seaside|island/i },
  { id: 'fall', name: 'Hallmark • Fall & Thanksgiving', re: /thanksgiving|autumn|harvest|fall for|falling|orchard|apple|cider/i },
  { id: 'mystery', name: 'Hallmark • Movies & Mysteries', re: /mystery|murder|detective|investigat|killer|crime/i, genre: 9648 },
  { id: 'other', name: 'Hallmark • More Movies', re: /.^/ }
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function tmdb(p, params = {}) {
  const qs = new URLSearchParams({ api_key: KEY, ...params })
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(`https://api.themoviedb.org/3${p}?${qs}`)
      if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue }
      if (!r.ok) throw new Error(`TMDB ${r.status} ${p}`)
      return await r.json()
    } catch (e) { if (attempt === 3) throw e; await sleep(600) }
  }
}

async function pool(items, limit, fn) {
  const out = []; let i = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx]).catch(e => { console.warn('skip:', e.message); return null })
    }
  }))
  return out
}

async function companyIds() {
  const ids = new Set()
  for (const q of ['Hallmark', 'Crown Media', 'Hallmark Media', 'Hallmark Channel', 'Hallmark Movies']) {
    const res = await tmdb('/search/company', { query: q })
    for (const c of res.results || []) if (/hallmark|crown media/i.test(c.name)) ids.add(c.id)
  }
  return [...ids]
}

async function discoverIds(companies) {
  const base = { with_companies: companies.join('|'), sort_by: 'primary_release_date.desc', include_adult: 'false' }
  const first = await tmdb('/discover/movie', { ...base, page: 1 })
  const pages = Math.min(first.total_pages || 1, 500)
  const rest = await pool(Array.from({ length: pages - 1 }, (_, i) => i + 2), 5, p => tmdb('/discover/movie', { ...base, page: p }))
  const ids = new Set()
  for (const pg of [first, ...rest]) for (const m of pg?.results || []) ids.add(m.id)
  return [...ids]
}

function classify(m) {
  const text = [m.title, m.overview, m.tagline, ...(m.keywords?.keywords || []).map(k => k.name)].join(' ')
  const genres = (m.genres || []).map(g => g.id)
  for (const c of CATEGORIES) {
    if (c.id === 'other') break
    if (c.re.test(text) || (c.genre && genres.includes(c.genre))) return c.id
  }
  return 'other'
}

function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return fallback } }

async function main() {
  const cache = readJson(CACHE_FILE, {})
  const companies = await companyIds()
  console.log('Company ids:', companies)
  if (!companies.length) throw new Error('No Hallmark companies found on TMDB')

  const ids = await discoverIds(companies)
  console.log(`Discovered ${ids.length} movies`)

  const now = Date.now()
  const todo = ids.filter(id => {
    const c = cache[id]
    if (!c) return true
    const age = now - c.fetched
    return age > 90 * DAY || (!c.imdb && age > 14 * DAY)
  })
  console.log(`Fetching details for ${todo.length} movies`)

  await pool(todo, 8, async id => {
    const m = await tmdb(`/movie/${id}`, { append_to_response: 'external_ids,keywords' })
    cache[id] = {
      fetched: now,
      imdb: m.external_ids?.imdb_id || null,
      name: m.title,
      date: m.release_date || '',
      poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : undefined,
      background: m.backdrop_path ? `https://image.tmdb.org/t/p/w1280${m.backdrop_path}` : undefined,
      description: m.overview || '',
      cat: classify(m)
    }
  })

  const items = Object.fromEntries(CATEGORIES.map(c => [c.id, []]))
  const seen = new Set()
  for (const id of ids) {
    const m = cache[id]
    if (!m || !m.imdb || seen.has(m.imdb)) continue
    seen.add(m.imdb)
    items[m.cat].push({
      id: m.imdb, type: 'movie', name: m.name, poster: m.poster, background: m.background,
      description: m.description, releaseInfo: m.date.slice(0, 4), _d: m.date
    })
  }
  for (const k in items) items[k].sort((a, b) => b._d.localeCompare(a._d)).forEach(x => delete x._d)

  const catalog = {
    generated: new Date().toISOString(), // always changes -> keeps the scheduled workflow "active"
    categories: CATEGORIES.map(({ id, name }) => ({ id, name })),
    items
  }
  if (seen.size < 20) throw new Error(`Only ${seen.size} movies found; refusing to overwrite catalog`)

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache))
  fs.writeFileSync(OUT_FILE, JSON.stringify(catalog))
  console.log('Done:', Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.length])))
}

main().catch(e => { console.error(e); process.exit(1) })
