# Hallmark Seasons – Stremio addon (GitHub Actions + AWS Lambda)

```
GitHub Actions (weekly) ──► builds catalog.json from TMDB ──► commits to repo
AWS Lambda (Function URL) ──► reads catalog.json from GitHub ──► serves Stremio addon
                          └──► proxies stream lookups to Torrentio / TorrentsDB
```

## Repo layout

```
build-catalog.js
.github/workflows/update-catalog.yml
lambda/index.mjs
README.md
```

## Part 1 – GitHub (builds the catalog automatically)

1. Create a **public** GitHub repo (public so the Lambda can read `catalog.json`
   without a token; it only contains public TMDB movie data).
2. Upload all the files above, keeping the folder structure.
3. Get a free TMDB API key: https://www.themoviedb.org/settings/api
4. Repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `TMDB_API_KEY`
   - Value: your key
5. Repo → **Settings → Actions → General → Workflow permissions** →
   choose **Read and write permissions** → Save.
6. Repo → **Actions** tab → **Update Hallmark catalog** → **Run workflow**.
   Wait a few minutes. When it finishes, `catalog.json` appears in the repo.
   From then on it refreshes itself every Monday.
7. Your catalog URL is:
   `https://raw.githubusercontent.com/<USER>/<REPO>/main/catalog.json`
   (open it in a browser to check it loads; use `master` if that is your branch name).

## Part 2 – AWS Lambda (serves the addon)

1. AWS Console → **Lambda → Create function** → *Author from scratch*
   - Name: `hallmark-addon`
   - Runtime: **Node.js 20.x** (or newer)
   - Architecture: arm64 is fine
2. In the **Code** tab, open `index.mjs`, delete its contents and paste in
   `lambda/index.mjs` from this project. Click **Deploy**.
3. **Configuration → General configuration → Edit**: Timeout = **20 seconds**.
4. **Configuration → Environment variables**:
   - `CATALOG_URL` = the raw GitHub URL from Part 1
   - `STREAM_SOURCES` = comma separated base URLs, e.g.
     `https://torrentio.strem.fun,https://torrentsdb.com`
     (add your own config to the URL if you use a debrid service, e.g.
     `https://torrentio.strem.fun/realdebrid=YOUR_KEY`)
5. **Configuration → Function URL → Create function URL**
   - Auth type: **NONE**
   - Leave the CORS box **unchecked** (the code already sends CORS headers).
   - Save and copy the URL, e.g. `https://abc123.lambda-url.eu-west-1.on.aws/`
6. Test in a browser: `<function-url>manifest.json` should show JSON.
   If you get **403 Forbidden**, open **Configuration → Permissions → Resource-based
   policy** and make sure the public Function URL permissions
   (`lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`) are present; recreate the
   Function URL from the console if they are not.

## Part 3 – Install in Stremio

Addons → paste `<function-url>manifest.json` → **Install**.
It syncs to your account, so it shows up on the TV automatically.

## Notes

- Set a **billing alert** in AWS (Billing → Budgets) so you are warned about any charge.
- Keep the Function URL private if you put a debrid key in `STREAM_SOURCES`
  (the key lives only in Lambda's environment variables, never in GitHub).
- To tune categories, edit the regexes in `build-catalog.js` and run the workflow again.
- GitHub pauses scheduled workflows after long repo inactivity. The build rewrites
  `catalog.json` every week, which counts as activity and prevents that.
