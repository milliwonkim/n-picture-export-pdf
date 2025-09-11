import { publish } from 'gh-pages'
import { cpSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dist = 'dist'

// Ensure SPA fallback so deep links work on GitHub Pages
try {
  const indexPath = join(dist, 'index.html')
  const fallback = join(dist, '404.html')
  if (existsSync(indexPath)) {
    cpSync(indexPath, fallback)
    console.log('Created SPA fallback 404.html')
  }
} catch (e) {
  console.warn('Could not create 404.html fallback:', e)
}

const branch = 'gh-pages'
const repo = process.env.GH_PAGES_REPO // optional override

publish(dist, {
  branch,
  repo, // undefined uses origin
  dotfiles: true,
  message: `Deploy ${new Date().toISOString()}`,
}, (err) => {
  if (err) {
    console.error('gh-pages deploy failed:', err)
    process.exit(1)
  }
  console.log(`Deployed to ${branch} branch via gh-pages.`)
})

