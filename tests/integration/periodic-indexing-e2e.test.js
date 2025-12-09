/**
 * End-to-end test for periodic indexing
 * Sends a real email and verifies it gets indexed and searchable within 10 minutes
 *
 * This test validates the complete workflow:
 * 1. Send email via Mail.app
 * 2. Wait for background indexing to run
 * 3. Search for the email
 * 4. Verify it was indexed correctly
 *
 * Run with: npm run test:integration:periodic
 *
 * NOTE: This test takes ~10 minutes to complete and requires:
 * - Mail.app configured and running
 * - Background indexing enabled
 * - Test email account configured
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import os from 'os'

// Test configuration
const TEST_TIMEOUT = 15 * 60 * 1000 // 15 minutes
const POLL_INTERVAL = 30 * 1000 // Check every 30 seconds
const MAX_WAIT_TIME = 12 * 60 * 1000 // Wait up to 12 minutes
const UNIQUE_MARKER = `periodic-test-${Date.now()}-${Math.random().toString(36).substring(7)}`

// Skip this test by default - it requires Mail.app configured and takes 12+ minutes
// Run with: RUN_E2E_TESTS=1 npm test to enable
describe.skipIf(!process.env.RUN_E2E_TESTS)('Periodic Indexing E2E', () => {
  let testEmailSubject
  let testEmailBody
  let indexPath
  let serverProcess = null

  beforeAll(() => {
    // Generate unique test email content
    testEmailSubject = `Test Email - ${UNIQUE_MARKER}`
    testEmailBody = `This is a test email for periodic indexing verification.\n\nUnique ID: ${UNIQUE_MARKER}\nTimestamp: ${new Date().toISOString()}`

    // Use production index path (or test index if available)
    indexPath = path.join(os.homedir(), '.apple-tools-mcp', 'vector-index')

    console.log(`\n📧 Test Configuration:`)
    console.log(`   Subject: ${testEmailSubject}`)
    console.log(`   Unique Marker: ${UNIQUE_MARKER}`)
    console.log(`   Index Path: ${indexPath}`)
    console.log(`   Max Wait: ${MAX_WAIT_TIME / 1000}s`)
  })

  afterAll(() => {
    // Cleanup: Mark the test email for deletion if needed
    if (serverProcess) {
      serverProcess.kill()
    }
  })

  it('should index a newly sent email within 10 minutes', async () => {
    // Step 1: Send test email via AppleScript
    console.log('\n📤 Step 1: Sending test email...')

    const sendEmailScript = `
      tell application "Mail"
        set newMessage to make new outgoing message with properties {subject:"${testEmailSubject}", content:"${testEmailBody}", visible:false}
        tell newMessage
          set sender to "me"
          make new to recipient with properties {address:"${await getCurrentUserEmail()}"}
          send
        end tell
      end tell
    `

    try {
      execSync(`osascript -e '${sendEmailScript.replace(/'/g, "'\"'\"'")}'`, { stdio: 'pipe' })
      console.log('   ✅ Email sent successfully')
    } catch (error) {
      throw new Error(`Failed to send test email: ${error.message}`)
    }

    // Step 2: Wait a moment for Mail.app to process
    await new Promise(resolve => setTimeout(resolve, 5000))

    // Step 3: Poll for the email to appear in search results
    console.log('\n🔍 Step 2: Waiting for periodic indexing to pick up the email...')
    console.log(`   (Polling every ${POLL_INTERVAL / 1000}s for up to ${MAX_WAIT_TIME / 60000} minutes)`)

    const startTime = Date.now()
    let found = false
    let attempts = 0

    while (!found && (Date.now() - startTime) < MAX_WAIT_TIME) {
      attempts++
      const elapsed = Math.floor((Date.now() - startTime) / 1000)

      console.log(`   Attempt ${attempts} (${elapsed}s elapsed)...`)

      // Search for the email using the unique marker
      const searchResult = await searchForEmail(UNIQUE_MARKER)

      if (searchResult.found) {
        found = true
        const indexingTime = Math.floor((Date.now() - startTime) / 1000)

        console.log(`\n   ✅ Email found after ${indexingTime}s!`)
        console.log(`   📊 Search Results:`)
        console.log(`      - Total Results: ${searchResult.totalResults}`)
        console.log(`      - Subject Match: ${searchResult.subjectMatch}`)
        console.log(`      - Content Match: ${searchResult.contentMatch}`)

        // Validate the indexed content
        expect(searchResult.found).toBe(true)
        expect(searchResult.subjectMatch).toBe(true)
        expect(searchResult.totalResults).toBeGreaterThan(0)
        expect(indexingTime).toBeLessThan(MAX_WAIT_TIME / 1000)

        break
      }

      // Wait before next attempt
      if (!found) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
      }
    }

    if (!found) {
      throw new Error(`Email was not indexed within ${MAX_WAIT_TIME / 60000} minutes`)
    }

    console.log('\n✅ Periodic indexing test passed!')

  }, TEST_TIMEOUT)

  it('should find the email via semantic search', async () => {
    console.log('\n🔎 Step 3: Testing semantic search...')

    // Search using semantic query (not exact match)
    const semanticQuery = 'periodic indexing verification test'
    const searchResult = await searchForEmail(semanticQuery)

    console.log(`   Query: "${semanticQuery}"`)
    console.log(`   Found: ${searchResult.found}`)
    console.log(`   Results: ${searchResult.totalResults}`)

    // Should find the email via semantic similarity
    expect(searchResult.found).toBe(true)
    expect(searchResult.totalResults).toBeGreaterThan(0)

    console.log('   ✅ Semantic search successful')
  }, TEST_TIMEOUT)
})

/**
 * Get current user's email address from Mail.app
 */
async function getCurrentUserEmail() {
  try {
    const script = `
      tell application "Mail"
        set defaultAccount to account 1
        set emailAddress to email addresses of defaultAccount
        return item 1 of emailAddress
      end tell
    `

    const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: 'utf-8',
      stdio: 'pipe'
    }).trim()

    return result || 'test@example.com'
  } catch (error) {
    console.warn('   ⚠️  Could not get user email, using fallback')
    return 'test@example.com'
  }
}

/**
 * Search for email using mail_search tool
 * Returns object with search results and metadata
 */
async function searchForEmail(query) {
  try {
    // Import the mail search functionality
    const { default: lancedb } = await import('@lancedb/lancedb')
    const { pipeline } = await import('@xenova/transformers')
    const path = await import('path')
    const os = await import('os')

    // Initialize search
    const indexPath = path.join(os.homedir(), '.apple-tools-mcp', 'vector-index')
    const db = await lancedb.connect(indexPath)

    // Check if table exists
    const tables = await db.tableNames()
    if (!tables.includes('emails')) {
      return {
        found: false,
        totalResults: 0,
        subjectMatch: false,
        contentMatch: false,
        error: 'Email table not found'
      }
    }

    const table = await db.openTable('emails')

    // Generate embedding for query
    const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
    const output = await embedder(query, { pooling: 'mean', normalize: true })
    const embedding = Array.from(output.data)

    // Search
    const results = await table
      .vectorSearch(embedding)
      .limit(10)
      .toArray()

    // Check if our test email is in results
    const testEmailFound = results.some(r =>
      r.subject?.includes(UNIQUE_MARKER) ||
      r.content?.includes(UNIQUE_MARKER)
    )

    const subjectMatch = results.some(r => r.subject?.includes(UNIQUE_MARKER))
    const contentMatch = results.some(r => r.content?.includes(UNIQUE_MARKER))

    return {
      found: testEmailFound,
      totalResults: results.length,
      subjectMatch,
      contentMatch,
      results: results.slice(0, 3) // Return top 3 for debugging
    }

  } catch (error) {
    console.error(`   ❌ Search error: ${error.message}`)
    return {
      found: false,
      totalResults: 0,
      subjectMatch: false,
      contentMatch: false,
      error: error.message
    }
  }
}
