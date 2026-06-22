// Relevance scoring for Reddit posts against campaign keywords

var PAIN_WORDS = [
  'frustrated', 'struggling', 'tired of', 'hate', 'stressed',
  'overwhelmed', 'broke', 'failing', 'give up', "doesn't work",
  'help me', 'sick of', 'annoying', 'confusing', 'behind',
];

export function scorePost(post, keywords) {
  var text = (post.title + ' ' + post.selftext).toLowerCase();
  var score = 0;

  // Keyword matches
  keywords.forEach(function (kw) {
    if (text.includes(kw.toLowerCase())) score += 20;
  });

  // Pain signals
  PAIN_WORDS.forEach(function (pw) {
    if (text.includes(pw)) score += 6;
  });

  // Question post (seeking advice = opportunity)
  if (post.title.includes('?') || text.includes('help') || text.includes('advice') || text.includes('recommend')) {
    score += 10;
  }

  // Comment count (fewer = more visibility)
  // Note: RSS feeds return 0 for num_comments, so all RSS posts get +12
  // This is fine since the bonus applies equally; AI scoring in pass 2 compensates
  if (post.num_comments < 5) score += 12;
  else if (post.num_comments < 15) score += 8;
  else if (post.num_comments < 30) score += 4;
  else if (post.num_comments > 150) score -= 10;

  return Math.max(0, Math.min(100, score));
}

export function matchesKeywords(post, keywords) {
  var text = (post.title + ' ' + post.selftext).toLowerCase();
  for (var i = 0; i < keywords.length; i++) {
    if (text.includes(keywords[i].toLowerCase())) return true;
  }
  return false;
}

export function timeAgo(utc) {
  var diff = (Date.now() / 1000 - utc) | 0;
  if (diff < 60) return 'just now';
  if (diff < 3600) return ((diff / 60) | 0) + 'm';
  if (diff < 86400) return ((diff / 3600) | 0) + 'h';
  return ((diff / 86400) | 0) + 'd';
}
