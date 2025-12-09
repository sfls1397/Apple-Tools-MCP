/**
 * Performance test data generators
 * Generates large datasets for performance testing
 */

const MAC_ABSOLUTE_EPOCH = 978307200

/**
 * Generate test emails with configurable size
 */
export function generateEmails(count, options = {}) {
  const {
    bodySize = 'medium', // small, medium, large
    attachmentRate = 0.2,
    mailboxes = ['INBOX', 'Sent', 'Archive', 'Work'],
    daysSpread = 365
  } = options

  const bodySizes = {
    small: 50,
    medium: 200,
    large: 1000
  }

  const bodyWordCount = bodySizes[bodySize] || bodySizes.medium
  const emails = []

  for (let i = 0; i < count; i++) {
    const mailbox = mailboxes[i % mailboxes.length]
    const daysAgo = Math.floor(Math.random() * daysSpread)
    const timestamp = Date.now() - (daysAgo * 24 * 60 * 60 * 1000)
    const hasAttachment = Math.random() < attachmentRate

    emails.push({
      id: i + 1,
      path: `/Users/test/Library/Mail/V10/${mailbox}.mbox/${i + 1}.emlx`,
      from: `sender${i % 100}@example.com`,
      fromName: `Sender ${i % 100}`,
      to: `recipient${i % 50}@example.com`,
      subject: `Test Email ${i}: ${generateWords(5)}`,
      body: generateWords(bodyWordCount),
      date: new Date(timestamp).toISOString(),
      timestamp,
      hasAttachment,
      mailbox,
      messageId: `<msg-${i}@example.com>`
    })
  }

  return emails
}

/**
 * Generate test messages
 */
export function generateMessages(count, options = {}) {
  const {
    groupChatRate = 0.3,
    attachmentRate = 0.1,
    daysSpread = 30
  } = options

  const messages = []
  const contacts = generateContacts(Math.min(count / 5, 100))

  for (let i = 0; i < count; i++) {
    const isGroup = Math.random() < groupChatRate
    const hasAttachment = Math.random() < attachmentRate
    const daysAgo = Math.floor(Math.random() * daysSpread)
    const timestamp = Date.now() - (daysAgo * 24 * 60 * 60 * 1000)
    const contact = contacts[i % contacts.length]

    messages.push({
      id: i + 1,
      ROWID: i + 1,
      text: generateWords(5 + Math.floor(Math.random() * 30)),
      sender: i % 2 === 0 ? 'Me' : contact.phone,
      date: new Date(timestamp).toISOString(),
      timestamp,
      chatId: isGroup ? Math.floor(i / 10) : i + 1000,
      chatIdentifier: isGroup ? `chat${Math.floor(i / 10)}` : contact.phone,
      chatName: isGroup ? `Group ${Math.floor(i / 10)}` : '',
      participantCount: isGroup ? 3 + Math.floor(Math.random() * 5) : 2,
      attachmentCount: hasAttachment ? 1 + Math.floor(Math.random() * 3) : 0,
      isGroup
    })
  }

  return messages
}

/**
 * Generate calendar events
 */
export function generateCalendarEvents(count, options = {}) {
  const {
    allDayRate = 0.15,
    daysAhead = 90,
    daysBack = 30,
    calendars = ['Work', 'Personal', 'Family']
  } = options

  const events = []
  const eventTypes = ['Meeting', 'Call', 'Review', 'Sync', 'Planning', 'Workshop', 'Interview', 'Demo']
  const locations = ['Conference Room A', 'Zoom', 'Office', 'Google Meet', '', 'Phone']

  for (let i = 0; i < count; i++) {
    const isAllDay = Math.random() < allDayRate
    const daysOffset = -daysBack + Math.floor(Math.random() * (daysAhead + daysBack))
    const startTime = Date.now() + (daysOffset * 24 * 60 * 60 * 1000)
    const duration = isAllDay ? 24 * 60 : (30 + Math.floor(Math.random() * 90)) // 30-120 mins
    const calendar = calendars[i % calendars.length]

    events.push({
      id: i + 1,
      ROWID: i + 1,
      title: `${eventTypes[i % eventTypes.length]} ${i + 1}`,
      summary: `${eventTypes[i % eventTypes.length]} ${i + 1}`,
      start: new Date(startTime).toISOString(),
      end: new Date(startTime + duration * 60 * 1000).toISOString(),
      startTimestamp: startTime,
      endTimestamp: startTime + duration * 60 * 1000,
      start_date: Math.floor(startTime / 1000) - MAC_ABSOLUTE_EPOCH,
      end_date: Math.floor((startTime + duration * 60 * 1000) / 1000) - MAC_ABSOLUTE_EPOCH,
      isAllDay,
      all_day: isAllDay ? 1 : 0,
      calendar,
      calendar_name: calendar,
      location: locations[i % locations.length],
      notes: generateWords(10),
      attendees: JSON.stringify([])
    })
  }

  return events
}

/**
 * Generate contacts
 */
export function generateContacts(count) {
  const firstNames = ['John', 'Jane', 'Bob', 'Alice', 'Charlie', 'Diana', 'Edward', 'Fiona']
  const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis']
  const companies = ['Acme Inc', 'TechCorp', 'StartupXYZ', 'BigCo', 'SmallBiz', '']

  const contacts = []

  for (let i = 0; i < count; i++) {
    const firstName = firstNames[i % firstNames.length]
    const lastName = lastNames[Math.floor(i / firstNames.length) % lastNames.length]

    contacts.push({
      id: i + 1,
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${i}@example.com`,
      phone: `+1555${String(i).padStart(7, '0')}`,
      company: companies[i % companies.length]
    })
  }

  return contacts
}

/**
 * Generate search queries for testing
 */
export function generateSearchQueries(count, options = {}) {
  const {
    complexity = 'mixed' // simple, medium, complex, mixed
  } = options

  const simpleQueries = [
    'meeting tomorrow',
    'email from john',
    'budget report',
    'project update',
    'lunch schedule'
  ]

  const mediumQueries = [
    'meeting with team about Q4 budget',
    'email from john about project deadline',
    'find all messages from last week',
    'calendar events next monday',
    'unread emails with attachments'
  ]

  const complexQueries = [
    'find all emails from john about the Q4 budget review meeting that happened last month',
    'search for messages discussing the project timeline and deliverables from the engineering team',
    'calendar events with external participants in the next two weeks excluding holidays',
    'emails with PDF attachments sent by the finance department regarding annual report',
    'all communication with the marketing team about the product launch campaign'
  ]

  const queries = []
  const queryPools = {
    simple: simpleQueries,
    medium: mediumQueries,
    complex: complexQueries,
    mixed: [...simpleQueries, ...mediumQueries, ...complexQueries]
  }

  const pool = queryPools[complexity] || queryPools.mixed

  for (let i = 0; i < count; i++) {
    queries.push(pool[i % pool.length])
  }

  return queries
}

/**
 * Generate text for embedding tests
 */
export function generateEmbeddingTexts(count, options = {}) {
  const {
    minLength = 20,
    maxLength = 300
  } = options

  const texts = []

  for (let i = 0; i < count; i++) {
    const length = minLength + Math.floor(Math.random() * (maxLength - minLength))
    const wordCount = Math.ceil(length / 6)
    texts.push(generateWords(wordCount))
  }

  return texts
}

/**
 * Generate vector embeddings (mock)
 */
export function generateMockEmbeddings(count, dimension = 384) {
  const embeddings = []

  for (let i = 0; i < count; i++) {
    const vector = new Float32Array(dimension)
    for (let j = 0; j < dimension; j++) {
      vector[j] = (Math.sin(i + j) + 1) / 2 * 0.2
    }
    embeddings.push(vector)
  }

  return embeddings
}

/**
 * Generate .emlx file content
 */
export function generateEmlxContent(email) {
  const contentType = email.hasAttachment
    ? 'multipart/mixed; boundary="boundary123"'
    : 'text/plain; charset="utf-8"'

  let content = `From: ${email.fromName} <${email.from}>
To: ${email.to}
Subject: ${email.subject}
Date: ${new Date(email.timestamp).toUTCString()}
Message-ID: ${email.messageId}
Content-Type: ${contentType}
`

  if (email.hasAttachment) {
    content += `Content-Disposition: attachment; filename="document.pdf"
`
  }

  content += `
${email.body}`

  return content
}

// Helper: Generate random words
const wordList = [
  'meeting', 'project', 'budget', 'review', 'team', 'schedule',
  'email', 'response', 'follow', 'update', 'report', 'analysis',
  'deadline', 'milestone', 'progress', 'feedback', 'discussion',
  'planning', 'quarterly', 'monthly', 'weekly', 'daily', 'urgent',
  'important', 'action', 'items', 'notes', 'summary', 'overview',
  'collaboration', 'sync', 'call', 'chat', 'message', 'reply',
  'customer', 'client', 'vendor', 'partner', 'stakeholder', 'manager',
  'engineer', 'designer', 'analyst', 'director', 'executive', 'team',
  'sprint', 'agile', 'scrum', 'kanban', 'roadmap', 'backlog', 'feature'
]

function generateWords(count) {
  const words = []
  for (let i = 0; i < count; i++) {
    words.push(wordList[Math.floor(Math.random() * wordList.length)])
  }
  return words.join(' ')
}

/**
 * Scale factor calculator for different test intensities
 */
export function getScaleFactor(intensity = 'normal') {
  const factors = {
    quick: 0.1,      // Fast smoke tests
    normal: 1.0,     // Standard tests
    thorough: 5.0,   // Thorough tests
    stress: 10.0     // Stress tests
  }
  return factors[intensity] || factors.normal
}

/**
 * Generate a dataset bundle for comprehensive testing
 */
export function generateTestDataBundle(scale = 1.0) {
  return {
    emails: generateEmails(Math.floor(1000 * scale)),
    messages: generateMessages(Math.floor(500 * scale)),
    events: generateCalendarEvents(Math.floor(200 * scale)),
    contacts: generateContacts(Math.floor(100 * scale)),
    queries: generateSearchQueries(Math.floor(50 * scale)),
    texts: generateEmbeddingTexts(Math.floor(100 * scale))
  }
}
