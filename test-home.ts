// Imported first by test.ts: Darce's modules fix their paths (~/.darce/logs, sessions, config) when they load,
// so HOME has to point at a throwaway folder before any of them do. Tests never touch the real ~/.darce.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'darce-test-home-'))
process.env.HOME = home
process.env.USERPROFILE = home
// Git commits in test repos still need an identity without the user's ~/.gitconfig
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'darce-test'
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@darce.dev'
