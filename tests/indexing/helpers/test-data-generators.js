
const MAC_ABSOLUTE_EPOCH = 978307200

export function generateTestEmails(count, options = {}) {
  const {
    bodySize = 100,
    attachmentRate = 0.2,
    mailbox = 'INBOX',
    daysBack = 30
  } = options

  const emails = []

  for (let i = 0; i < count; i++) {
    const timestamp = Date.now() - (i * Math.floor(daysBack * 24 * 60 * 60 * 1000 / count))
    const hasAttachment = Math.random() < attachmentRate

    emails.push({
      path: `/Users/test/Library/Mail/V10/Account/${mailbox}.mbox/${i + 1}.emlx`,
      content: generateEmailContent({
        from: `sender${i}@example.com`,
        fromName: `Sender ${i}`,
        to: `recipient${i}@example.com`,
        toName: `Recipient ${i}`,
        subject: `Test Subject ${i} - ${randomWords(3)}`,
        date: new Date(timestamp).toUTCString(),
        body: randomWords(Math.ceil(bodySize / 5)).repeat(Math.ceil(bodySize / 50)),
        hasAttachment,
        messageId: `<msg-${i}-${timestamp}@example.com>`
      }),
      timestamp
    })
  }

  return emails
}

export function generateEmailContent(options) {
  const {
    from,
    fromName = '',
    to,
    toName = '',
    subject,
    date,
    body,
    hasAttachment = false,
    messageId = `<${Date.now()}@example.com>`,
    cc = '',
    isFlagged = false
  } = options

  const fromHeader = fromName ? `${fromName} <${from}>` : from
  const toHeader = toName ? `${toName} <${to}>` : to

  let content = `From: ${fromHeader}
To: ${toHeader}
Subject: ${subject}
Date: ${date}
Message-ID: ${messageId}
`

  if (cc) {
    content += `Cc: ${cc}\n`
  }

  if (isFlagged) {
    content += `X-Flagged: Yes\n`
  }

  if (hasAttachment) {
    content += `Content-Type: multipart/mixed; boundary="boundary-${Date.now()}"
Content-Disposition: attachment; filename="document.pdf"
`
  } else {
    content += `Content-Type: text/plain; charset="utf-8"\n`
  }

  content += `\n${body}`

  return content
}

export function generateTestMessages(count, options = {}) {
  const {
    groupChatRate = 0.3,
    attachmentRate = 0.1,
    daysBack = 7
  } = options

  const messages = []

  for (let i = 0; i < count; i++) {
    const isGroup = Math.random() < groupChatRate
    const hasAttachment = Math.random() < attachmentRate
    const timestamp = Date.now() - (i * Math.floor(daysBack * 24 * 60 * 60 * 1000 / count))
    const macTime = Math.floor(timestamp / 1000) - MAC_ABSOLUTE_EPOCH

    messages.push({
      ROWID: i + 1,
      id: String(i + 1),
      date: new Date(timestamp).toLocaleString(),
      dateTimestamp: Math.floor(timestamp / 1000),
      sender: i % 2 === 0 ? 'Me' : `+1555${String(i).padStart(7, '0')}`,
      text: `Test message ${i}: ${randomWords(5 + Math.floor(Math.random() * 20))}`,
      chatId: isGroup ? Math.floor(i / 5) + 1 : i + 100,
      chatIdentifier: isGroup ? `chat${Math.floor(i / 5)}` : `+1555${String(i).padStart(7, '0')}`,
      chatName: isGroup ? `Group Chat ${Math.floor(i / 5)}` : '',
      participantCount: isGroup ? 3 + Math.floor(Math.random() * 5) : 2,
      attachmentCount: hasAttachment ? 1 : 0,
      attributedBodyHex: null
    })
  }

  return messages
}

export function generateCalendarEvents(count, options = {}) {
  const {
    allDayRate = 0.2,
    recurringRate = 0.3,
    daysAhead = 30,
    daysBack = 7
  } = options

  const events = []
  const now = Date.now()
  const calendars = ['Work', 'Personal', 'Family', 'Holidays']
  const eventTypes = ['Meeting', 'Call', 'Review', 'Sync', 'Planning', 'Demo', 'Interview', 'Workshop']
  const locations = ['Conference Room A', 'Zoom', 'Office', 'Google Meet', 'Phone', '']

  for (let i = 0; i < count; i++) {
    const isAllDay = Math.random() < allDayRate
    const isRecurring = Math.random() < recurringRate
    const daysOffset = -daysBack + Math.floor(Math.random() * (daysAhead + daysBack))
    const startTime = now + (daysOffset * 24 * 60 * 60 * 1000)

    const startMac = Math.floor(startTime / 1000) - MAC_ABSOLUTE_EPOCH
    const endMac = isAllDay
      ? startMac + (24 * 60 * 60)
      : startMac + (60 * 60)

    const title = `${eventTypes[i % eventTypes.length]} ${i + 1}`

    events.push({
      id: i + 1,
      ROWID: i + 1,
      summary: title,
      title,
      start_date: startMac,
      end_date: endMac,
      start: new Date(startTime).toLocaleString(),
      end: new Date(startTime + (isAllDay ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000)).toLocaleString(),
      startTimestamp: startTime,
      all_day: isAllDay ? 1 : 0,
      isAllDay,
      calendar_name: calendars[i % calendars.length],
      calendar: calendars[i % calendars.length],
      location: locations[i % locations.length],
      description: isRecurring ? `Recurring event ${i}` : `Event notes ${i}`,
      notes: isRecurring ? `Recurring event ${i}` : `Event notes ${i}`,
      attendees: JSON.stringify([]),
      attendeeCount: 0
    })
  }

  return events
}

export function generateSearchTexts(count, options = {}) {
  const {
    minLength = 20,
    maxLength = 200
  } = options

  const texts = []
  const topics = [
    'meeting project budget quarterly review',
    'email response follow up action items',
    'calendar schedule appointment reminder',
    'message chat conversation reply',
    'document report analysis summary',
    'task deadline milestone progress',
    'team collaboration discussion feedback'
  ]

  for (let i = 0; i < count; i++) {
    const topic = topics[i % topics.length]
    const length = minLength + Math.floor(Math.random() * (maxLength - minLength))
    const wordCount = Math.ceil(length / 6)
    texts.push(`${topic} ${randomWords(wordCount)}`.substring(0, length))
  }

  return texts
}

export function generateSimilarTextPairs(count) {
  const pairs = []
  const templates = [
    ['Meeting about Q4 budget planning', 'Discussion regarding Q4 budget'],
    ['Weekly team sync call', 'Team weekly standup meeting'],
    ['Project deadline reminder', 'Reminder about project due date'],
    ['Customer feedback review', 'Reviewing customer comments'],
    ['Interview schedule confirmation', 'Confirming interview time']
  ]

  for (let i = 0; i < count; i++) {
    const template = templates[i % templates.length]
    pairs.push({
      text1: template[0],
      text2: template[1],
      expectedSimilarity: 0.7
    })
  }

  return pairs
}

export function generateDissimilarTextPairs(count) {
  const pairs = []
  const templates = [
    ['Quarterly financial review meeting', 'Recipe for chocolate cake'],
    ['Software deployment schedule', 'Beach vacation photos'],
    ['Project management update', 'Cat videos compilation'],
    ['Budget approval workflow', 'Weather forecast tomorrow'],
    ['Team performance metrics', 'Best pizza restaurants']
  ]

  for (let i = 0; i < count; i++) {
    const template = templates[i % templates.length]
    pairs.push({
      text1: template[0],
      text2: template[1],
      expectedSimilarity: 0.3
    })
  }

  return pairs
}

const wordList = [
  'meeting', 'project', 'budget', 'review', 'team', 'schedule',
  'email', 'response', 'follow', 'update', 'report', 'analysis',
  'deadline', 'milestone', 'progress', 'feedback', 'discussion',
  'planning', 'quarterly', 'monthly', 'weekly', 'daily', 'urgent',
  'important', 'action', 'items', 'notes', 'summary', 'overview',
  'collaboration', 'sync', 'call', 'chat', 'message', 'reply'
]

function randomWords(count) {
  const words = []
  for (let i = 0; i < count; i++) {
    words.push(wordList[Math.floor(Math.random() * wordList.length)])
  }
  return words.join(' ')
}

export function generateEmailFilePaths(count, mailbox = 'INBOX') {
  const paths = []
  for (let i = 0; i < count; i++) {
    paths.push(`/Users/test/Library/Mail/V10/Account/${mailbox}.mbox/${i + 1}.emlx`)
  }
  return paths.join('\n')
}
