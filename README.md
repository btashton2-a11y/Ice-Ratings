	# Ice Ratings

FotMob-style player ratings for every NHL game. Each player's game is scored from 23 stats (box score, shot-by-shot expected goals, and on-ice results from the NHL's shift charts), then graded against every game played at the same position this season.

The site updates itself: games refresh every minute while they're live, and the season comparison rebuilds every morning. Nothing runs on your computer.

## Put it online (about 15 minutes, no coding)

You'll make two free accounts: GitHub (stores the files) and Vercel (runs the site).

### 1. Put the files on GitHub

1. Go to github.com and sign up (or sign in).
2. Click the **+** in the top-right corner, then **New repository**.
3. Name it `ice-ratings`. Leave everything else as is and click **Create repository**.
4. On the next page, click the link that says **uploading an existing file**.
5. Unzip `ice-ratings.zip` on your computer. Open the `ice-ratings` folder, select everything inside it (`api`, `lib`, `public`, `package.json`, `vercel.json`, `README.md`), and drag it all onto the GitHub page.
   - Drag the contents, not the `ice-ratings` folder itself. `package.json` must end up at the top level of the repository.
6. Wait for the files to finish uploading, then click **Commit changes**.

### 2. Run it on Vercel

1. Go to vercel.com and click **Sign Up**. Choose the **Hobby** (free) plan and **Continue with GitHub**.
2. On your Vercel dashboard, click **Add New…**, then **Project**.
3. Find `ice-ratings` in the list and click **Import**. If it's not listed, click **Adjust GitHub App Permissions** and give Vercel access to that repository.
4. Leave every setting as it is. The framework should say **Other**. Click **Deploy**.
5. After about a minute you'll get a link like `ice-ratings-yourname.vercel.app`. That's your site.

The first time anyone opens the site, it builds the season comparison from every game played so far. That can take up to a minute. After that it's cached and loads quickly. Before the comparison finishes, the page grades players against the games on screen.

## Using it

- Live games show a red **LIVE** tag and update every minute.
- Use the arrows next to the date to browse earlier nights.
- Tap a game to open it. Tap a player for the full breakdown of his rating.
- Every game and date has its own link (for example `…vercel.app/#g2026020090`) you can share.
- The sliders at the bottom change the rating scale and stat weights for you only. They're saved in your browser.

## Making changes

To change something, edit the file on GitHub (open it, click the pencil icon, then **Commit changes**). Vercel redeploys automatically within a minute.

- Default stat weights and rating scale: `public/engine.js` (`DEFAULTS` and `SCALE_DEFAULT`)
- Expected-goals model: `xgModel` in `public/engine.js`
- Page layout and colors: `public/index.html` and `public/app.js`

## How it's built

- `api/schedule.js`: the games on a date, with live scores and clocks
- `api/game.js`: one game's data: rosters, every shot with expected goals, goals, and on-ice stats from shift charts (or the official time-on-ice reports when the shift-chart API has no data)
- `api/day-raws.js`: game scores for one day's finished games, cached for 30 days
- `api/baseline.js`: combines every day's game scores into the season comparison; runs daily at 11:00 UTC through a Vercel cron job
- `public/engine.js`: the rating formula, shared by the server and the page

Data comes from the NHL's public feeds (api-web.nhle.com, api.nhle.com, and nhl.com reports). These aren't official APIs and the NHL can change them without notice. If the site stops loading games, that's the first thing to check.
