// AWS Lambda (Node.js 20+) handler for a Stremio addon, used behind a Function URL.
// Env vars:
//   CATALOG_URL     raw URL of catalog.json in your GitHub repo (required)
//   STREAM_SOURCES  comma separated stream addon base URLs, no /manifest.json (optional)

const CATALOG_URL = process.env.CATALOG_URL
const SOURCES = (process.env.STREAM_SOURCES || 'https://torrentio.strem.fun,https://torrentsdb.com')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)

const PAGE_SIZE = 100
const CATALOG_TTL = 6 * 60 * 60 * 1000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
}

let catalog = null
let catalogAt = 0
let imdbSet = new Set()

async function getCatalog() {
  if (catalog && Date.now() - catalogAt < CATALOG_TTL) return catalog
  try {
    const r = await fetch(CATALOG_URL)
    if (!r.ok) throw new Error(`catalog fetch ${r.status}`)
    catalog = await r.json()
    catalogAt = Date.now()
    imdbSet = new Set(Object.values(catalog.items).flat().map(m => m.id))
  } catch (e) {
    if (!catalog) throw e          // nothing cached: fail
    console.warn('Using stale catalog:', e.message)
    catalogAt = Date.now() - CATALOG_TTL + 5 * 60 * 1000 // retry in 5 min
  }
  return catalog
}

function buildManifest(cat) {
  return {
    id: 'community.hallmark.seasons',
    version: '1.0.0',
    name: 'Hallmark Seasons',
    description: "Every Hallmark movie, split into Halloween, Christmas, Valentine's, Spring, Summer, Fall and more.",
    resources: ['catalog', 'stream'],
    types: ['movie'],
    idPrefixes: ['tt'],
    catalogs: cat.categories.map(c => ({
      type: 'movie',
      id: `hallmark-${c.id}`,
      name: c.name,
      extra: [{ name: 'skip', isRequired: false }, { name: 'search', isRequired: false }]
    }))
  }
}

async function fetchStreams(src, imdb) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 12000)
  try {
    const r = await fetch(`${src}/stream/movie/${imdb}.json`, { signal: ctrl.signal })
    if (!r.ok) return []
    const { streams = [] } = await r.json()
    const tag = new URL(src).hostname.replace(/^www\./, '').split('.')[0]
    return streams.map(s => ({ ...s, name: `[${tag}] ${s.name || ''}`.trim() }))
  } catch { return [] } finally { clearTimeout(t) }
}

const json = (body, maxAge = 0, status = 200) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-cache',
    ...CORS
  },
  body: JSON.stringify(body)
})

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || 'GET'
  if (method === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' }

  try {
    const parts = (event.rawPath || '/').split('/').filter(Boolean)
    if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.json$/, '')

    if (parts.length === 0) {
      return { statusCode: 200, headers: { 'Content-Type': 'text/plain', ...CORS }, body: 'Hallmark Seasons addon. Install /manifest.json in Stremio.' }
    }

    const cat = await getCatalog()

    // /manifest.json
    if (parts[0] === 'manifest') return json(buildManifest(cat), 3600)

    // /catalog/movie/hallmark-christmas.json  or  /catalog/movie/hallmark-christmas/skip=100.json
    if (parts[0] === 'catalog' && parts[1] === 'movie' && parts[2]) {
      const key = decodeURIComponent(parts[2]).replace(/^hallmark-/, '')
      let list = cat.items[key] || []
      const extra = new URLSearchParams(parts[3] || '')
      const search = extra.get('search')
      if (search) {
        const q = search.toLowerCase()
        list = list.filter(m => m.name.toLowerCase().includes(q))
      }
      const skip = parseInt(extra.get('skip') || '0', 10) || 0
      return json({ metas: list.slice(skip, skip + PAGE_SIZE) }, 3600)
    }

    // /stream/movie/tt1234567.json
    if (parts[0] === 'stream' && parts[1] === 'movie' && parts[2]) {
      const id = decodeURIComponent(parts[2])
      if (!imdbSet.has(id)) return json({ streams: [] }, 3600)  // only Hallmark titles
      const all = (await Promise.all(SOURCES.map(s => fetchStreams(s, id)))).flat()
      const seen = new Set()
      const streams = all.filter(s => {
        const k = s.infoHash ? s.infoHash.toLowerCase() : s.url
        if (!k || seen.has(k)) return false
        seen.add(k)
        return true
      })
      return json({ streams }, 900)
    }

    return json({ error: 'Not found' }, 0, 404)
  } catch (e) {
    console.error(e)
    return json({ error: 'Internal error' }, 0, 500)
  }
}
