import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { fetchAppStoreListing, isPlayLink } from './marketing';

// ── Core questions (fast, conversational, one at a time) ──
var CORE_QUESTIONS = [
  { key: 'whatItDoes', label: 'What does your product do?', placeholder: 'e.g. 60-day cash flow forecasting app for iOS — shows your projected daily balance', why: 'This is the foundation. It defines what we are marketing and feeds every piece of generated content.' },
  { key: 'whoItsFor', label: 'Who is it for?', placeholder: 'e.g. People living paycheck to paycheck who hate traditional budgeting', why: 'Your audience decides which platforms, subreddits, and tone the plan targets.' },
  { key: 'howItsDifferent', label: 'How is it different from alternatives?', placeholder: 'e.g. No bank login, no subscription, forecasting not budgeting', why: 'Your differentiator is the hook in every post, reply, and listing — it is what makes people choose you.' },
  { key: 'price', label: 'What does it cost?', placeholder: 'e.g. $4.99 one-time', why: 'Price drives positioning and the market grade (one-time vs subscription is itself a selling point).' },
];

// ── Market questions (required — feed the market grade) ──
var MARKET_QUESTIONS = [
  { key: 'competitors', label: 'Who are your direct competitors? Name them, their pricing, and rough audience size.', placeholder: 'e.g. YNAB ($109/yr, large), Copilot ($95/yr, mid)...', why: 'We grade your market and position you against alternatives. Knowing who you are up against is essential.' },
  { key: 'problemSize', label: 'How big is the problem you solve?', placeholder: 'e.g. Millions live paycheck to paycheck', why: 'A bigger, more painful problem means more reach and a stronger market grade.' },
  { key: 'marketDirection', label: 'Is this market growing or shrinking?', placeholder: 'e.g. Budgeting apps are growing', why: 'Growing markets are easier to win. We factor direction into your grade and strategy.' },
  { key: 'currentAlternatives', label: 'What does your audience use today to solve this?', placeholder: 'e.g. Spreadsheets, mental math, or nothing', why: 'What people use now reveals the gap you fill and how to frame the switch.' },
  { key: 'validation', label: 'Have you validated demand? (downloads, waitlist, Reddit requests, reviews)', placeholder: 'e.g. 200 downloads, 15 reviews, posts asking for this', why: 'Evidence of demand de-risks the plan and lifts your market grade.' },
  { key: 'distributionAdvantage', label: 'Any distribution advantage? (audience, channel, community access)', placeholder: 'e.g. None yet / a 5k-subscriber newsletter', why: 'An existing audience or channel can change the whole strategy. It is a major lever.' },
];

var SUMMARY_SYSTEM = 'You are helping a founder build a marketing campaign. Given their answers about a product, write a warm, plain-language summary paragraph (not a form, not bullet points) reflecting back what you understand: what the product is, who it is for, the price, and the key differentiator. Keep it to 3-5 sentences and end with "Does this sound right?". Return JSON: {"summary":"..."}. Output ONLY the JSON object.';

var EVAL_SYSTEM = 'You are building a rich marketing context for a product so an AI can later write Reddit replies, social posts, and long-form content in the founder\'s voice.\n\nFocus ONLY on: specific features and how they work, the user experience, audience pain points in their own words, what users love, the founder\'s background/credibility, and tone/voice. Do NOT ask about competitors, market size, demand validation, or distribution advantage — those are collected separately, so asking them here would be a repeat.\n\nYou already have the full transcript above. Before asking anything, scan it: if a topic appears in ANY prior question or answer (even briefly, even phrased differently), it is already covered — do NOT ask about it again in any form. Ask only about a genuinely missing area, one specific question at a time. Aim for a natural depth of about 5 to 10 follow-ups total: go deep enough to capture a rich brand voice and concrete detail, but do not pad with trivial questions. Return full once the context is genuinely rich enough to write long-form content in the founder voice.\n\nReturn JSON only:\n- Need more: {"level":"social" or "thin","question":"one follow-up","why":"one sentence on why it matters","progress":<integer 0-100 estimating how complete the context now is>}\n  ("thin" = barely enough; "social" = enough for replies/short posts)\n- Enough for anything (long-form included): {"level":"full","progress":100}\nOutput ONLY the JSON object.';

var GENERATE_SYSTEM = 'You are building the marketing ground-truth document for a product. Using everything provided (core answers, follow-ups, and market answers), produce:\n\n1. "context": a rich, long-form brand brief (several paragraphs) detailed enough that an AI given only this could write a Medium article, a Product Hunt listing, a Reddit comment in the founder\'s voice, and a cold email. Cover: what it does and how it works mechanically, the user experience, audience pain points in their language, differentiation vs each competitor, price, the founder\'s credibility, what users love, and the founder\'s tone (inferred from any examples).\n3. "keywords": Reddit/conversational pain-language phrases the audience uses when describing the problem (NOT product features). For finding discussions.\n4. "asoKeywords": short App Store search terms a shopper would type to find an app like this (commercial intent, distinct from the conversational keywords).\n5. "subreddits": relevant subreddit names (no r/ prefix).\n6. "marketGrade": a single letter A-F grading market potential from the market answers.\n7. "marketReasoning": one honest plain-language paragraph explaining the grade. Be direct, not encouraging for its own sake.\n\nNever use em dashes in generated content. Return JSON: {"context":"...","keywords":["..."],"asoKeywords":["..."],"subreddits":["..."],"marketGrade":"B","marketReasoning":"..."}. Output ONLY the JSON object.';

var PREVIEW_SYSTEM = 'Given a product marketing context, produce quick previews so the founder can sanity-check the voice and positioning. Return JSON: {"redditReply":"a sample helpful Reddit reply to a plausible relevant post, in the founder voice, product mentioned only naturally","xPost":"a sample X/Twitter post under 280 chars","subredditReasons":[{"sub":"name","reason":"one line why"}]}. Never use em dashes. Output ONLY the JSON object.';

export default function CampaignOnboarding({ colors, onSave, onCancel, existingCampaign, callAI }) {
  var isEdit = !!existingCampaign;

  // Steps: name -> core -> summary -> followups -> market -> generating -> review
  var [step, setStep] = useState(isEdit ? 'review' : 'name');
  var [error, setError] = useState(null);
  var [busy, setBusy] = useState(false);
  var [inputVal, setInputVal] = useState('');

  // Captured data
  var [name, setName] = useState(isEdit ? existingCampaign.name : '');
  var [answers, setAnswers] = useState(isEdit ? (existingCampaign.answers || {}) : {});
  var [marketAnswers, setMarketAnswers] = useState(isEdit ? ((existingCampaign.market && existingCampaign.market.answers) || {}) : {});
  var [summary, setSummary] = useState('');
  var [conversation, setConversation] = useState([]);
  var [aiQuestion, setAiQuestion] = useState(null);
  var [readinessLevel, setReadinessLevel] = useState('thin');

  // Generated / editable outputs
  var [context, setContext] = useState(isEdit ? existingCampaign.context : '');
  var [subsText, setSubsText] = useState(isEdit ? (existingCampaign.subs || []).join(', ') : '');
  var [kwText, setKwText] = useState(isEdit ? (existingCampaign.keywords || []).join(', ') : '');
  var [asoText, setAsoText] = useState(isEdit ? (existingCampaign.asoKeywords || []).join(', ') : '');
  var [appStoreId, setAppStoreId] = useState(isEdit ? (existingCampaign.appStoreId || '') : '');
  var [playPackage, setPlayPackage] = useState(isEdit ? (existingCampaign.playPackage || '') : '');
  var [toneExamples, setToneExamples] = useState(isEdit ? (existingCampaign.toneExamples || '') : '');
  var [marketGrade, setMarketGrade] = useState(isEdit ? ((existingCampaign.market && existingCampaign.market.grade) || '') : '');
  var [marketReasoning, setMarketReasoning] = useState(isEdit ? ((existingCampaign.market && existingCampaign.market.reasoning) || '') : '');
  var [previews, setPreviews] = useState(null);

  var [coreIndex, setCoreIndex] = useState(0);
  var [marketIndex, setMarketIndex] = useState(0);
  var [copied, setCopied] = useState(false);
  var [whyOpen, setWhyOpen] = useState(false);
  var [aiWhy, setAiWhy] = useState('');
  var [progress, setProgress] = useState(0);
  var MAX_FOLLOWUPS = 12; // safety net only; the AI naturally lands around 5-10
  var FOLLOWUP_MIN = 150; // open-ended answers should be a few sentences of narrative
  var MARKET_MIN = 40;
  function coreMin(key) { return key === 'price' ? 2 : 150; }

  function charHint(min) {
    var len = inputVal.trim().length;
    if (len < min) {
      return (
        <Text style={{ color: colors.accent, fontSize: 11, marginTop: 8 }}>
          {len}/{min} — aim for a few sentences. Narrative detail makes everything the AI generates much better.
        </Text>
      );
    }
    if (len >= 500) {
      return (
        <Text style={{ color: colors.green, fontSize: 11, marginTop: 8 }}>
          {len} characters · excellent — this depth gives the AI a rich, accurate picture to write from.
        </Text>
      );
    }
    return (
      <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 8 }}>
        {len} characters · good. More narrative is always better — the AI writes from this.
      </Text>
    );
  }

  function copyText(t) {
    Clipboard.setStringAsync(t || '');
    setCopied(true);
    setTimeout(function () { setCopied(false); }, 1500);
  }

  function topNav(backFn) {
    return (
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        {backFn ? (
          <TouchableOpacity onPress={backFn} style={{ flexDirection: 'row', alignItems: 'center', gap: 2, padding: 4 }}>
            <Ionicons name="chevron-back" size={18} color={colors.textSecondary} />
            <Text style={{ color: colors.textSecondary, fontSize: 14, fontWeight: '600' }}>Back</Text>
          </TouchableOpacity>
        ) : <View style={{ width: 1 }} />}
        <TouchableOpacity onPress={onCancel} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, padding: 4 }}>
          <Text style={{ color: colors.textMuted, fontSize: 14 }}>Exit</Text>
          <Ionicons name="close" size={18} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
    );
  }

  function copyBtn(text) {
    return (
      <TouchableOpacity
        onPress={function () { copyText(text); }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginBottom: 14, paddingVertical: 2 }}
      >
        <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={14} color={copied ? colors.green : colors.textMuted} />
        <Text style={{ color: copied ? colors.green : colors.textMuted, fontSize: 12 }}>{copied ? 'Copied!' : 'Copy question'}</Text>
      </TouchableOpacity>
    );
  }

  // One continuous bar across the whole flow: follow-ups fill 10-70%, the
  // market questions carry it from 70-100%.
  function progressBar() {
    var overall, label;
    if (step === 'market') {
      overall = Math.round(70 + (marketIndex / MARKET_QUESTIONS.length) * 30);
      label = 'Assessing market · question ' + (marketIndex + 1) + ' of ' + MARKET_QUESTIONS.length;
    } else {
      overall = Math.round(10 + (Math.min(100, progress) / 100) * 60);
      label = 'Building context · ' + progress + '%';
    }
    var p = Math.max(4, Math.min(100, overall));
    return (
      <View style={{ marginBottom: 16 }}>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.card2, overflow: 'hidden' }}>
          <View style={{ width: p + '%', height: 6, backgroundColor: overall >= 95 ? colors.green : colors.primary }} />
        </View>
        <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 5 }}>{label}</Text>
      </View>
    );
  }

  // Question + ⓘ "why are you asking this?" toggle + copy.
  function questionBlock(q, why) {
    return (
      <View style={{ marginBottom: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
          <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600', lineHeight: 24, flex: 1 }}>{q}</Text>
          {why ? (
            <TouchableOpacity onPress={function () { setWhyOpen(!whyOpen); }} style={{ paddingTop: 2 }}>
              <Ionicons name={whyOpen ? 'information-circle' : 'information-circle-outline'} size={20} color={whyOpen ? colors.primary : colors.textMuted} />
            </TouchableOpacity>
          ) : null}
        </View>
        {whyOpen && why ? (
          <View style={{ backgroundColor: colors.card2, borderRadius: 8, padding: 10, marginTop: 8 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 12, lineHeight: 17 }}>{why}</Text>
          </View>
        ) : null}
        <View style={{ marginTop: 8 }}>{copyBtn(q)}</View>
      </View>
    );
  }

  // Listing-import state
  var [appLink, setAppLink] = useState('');
  var [pastedDesc, setPastedDesc] = useState('');
  var [bootstrapText, setBootstrapText] = useState(''); // listing/description used to seed context

  function parseList(str) {
    return str.split(/[,\n]+/).map(function (s) { return s.replace(/^r\//i, '').trim(); }).filter(function (s) { return s.length > 0; });
  }

  function friendly(e) {
    var m = (e && e.message) || String(e);
    if (m.indexOf('No API key') !== -1) return 'Add your Gemini API key in Settings, then try again.';
    if (m.indexOf('Daily AI budget') !== -1) return m + ' (raise the cap in Settings if needed).';
    return m;
  }

  function extractJSON(txt) {
    var s = txt.replace(/```json|```/g, '');
    var depth = 0, start = -1;
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '{') { if (!depth) start = i; depth++; }
      if (s[i] === '}') { depth--; if (!depth && start >= 0) return JSON.parse(s.slice(start, i + 1)); }
    }
    throw new Error('No JSON found in AI response');
  }

  function convoText() {
    var parts = [];
    if (bootstrapText) parts.push('App store listing / description:\n' + bootstrapText.slice(0, 3000));
    CORE_QUESTIONS.forEach(function (q) { if (answers[q.key]) parts.push(q.label + ' ' + answers[q.key].slice(0, 1500)); });
    conversation.forEach(function (c) { parts.push((c.role === 'q' ? 'Q: ' : 'A: ') + (c.text || '').slice(0, 1500)); });
    return parts.join('\n');
  }

  // Compact transcript for the eval call: keeps EVERY Q&A pair (so no topic is
  // forgotten and re-asked) while capping each answer so the prompt stays bounded.
  function compactTranscript(convo) {
    var parts = [];
    if (bootstrapText) parts.push('Listing / description:\n' + bootstrapText.slice(0, 1500));
    CORE_QUESTIONS.forEach(function (q) {
      if (answers[q.key]) parts.push('Q: ' + q.label + '\nA: ' + answers[q.key].slice(0, 600));
    });
    for (var i = 0; i < convo.length; i += 2) {
      var qn = convo[i] ? convo[i].text : '';
      var an = convo[i + 1] ? convo[i + 1].text : '';
      parts.push('Q: ' + qn + '\nA: ' + an.slice(0, 600));
    }
    return parts.join('\n\n');
  }

  // Read an App Store listing (or use a pasted description) to seed the context.
  async function readListing() {
    setBusy(true); setError(null);
    try {
      var text = '';
      if (appLink && !isPlayLink(appLink)) {
        var listing = await fetchAppStoreListing(appLink);
        if (listing.appStoreId) setAppStoreId(listing.appStoreId);
        if (!name.trim() && listing.name) setName(listing.name);
        text = (listing.name ? listing.name + '\n' : '') + listing.description
          + (listing.price ? '\nPrice: ' + listing.price : '')
          + (listing.genre ? '\nCategory: ' + listing.genre : '')
          + (listing.rating ? '\nRating: ' + listing.rating + ' (' + (listing.ratingCount || 0) + ')' : '');
      } else if (pastedDesc.trim()) {
        text = pastedDesc.trim();
      } else if (appLink && isPlayLink(appLink)) {
        throw new Error("I can't auto-read Google Play listings yet. Paste your description below, or answer the questions.");
      } else {
        throw new Error('Paste an App Store link or your listing description.');
      }
      setBootstrapText(text);
      await buildSummaryFromText(text);
    } catch (e) {
      setError(friendly(e));
      setBusy(false);
    }
  }

  async function buildSummaryFromText(text) {
    setBusy(true); setError(null);
    try {
      var raw = await callAI('Product: ' + name + '\n\nApp store listing / description:\n' + text.slice(0, 3000), SUMMARY_SYSTEM, 'onboard-summary');
      setSummary(extractJSON(raw).summary || '');
      setStep('summary');
    } catch (e) { setError(friendly(e)); }
    setBusy(false);
  }

  // ── Step transitions ──
  async function submitCore() {
    if (!inputVal.trim()) return;
    var next = Object.assign({}, answers);
    next[CORE_QUESTIONS[coreIndex].key] = inputVal.trim();
    setAnswers(next);
    setInputVal('');
    setWhyOpen(false);
    if (coreIndex < CORE_QUESTIONS.length - 1) {
      setCoreIndex(coreIndex + 1);
    } else {
      await buildSummary(next);
    }
  }

  async function buildSummary(ans) {
    setBusy(true); setError(null);
    try {
      var prompt = 'Product: ' + name + '\n' + CORE_QUESTIONS.map(function (q) { return q.label + ' ' + (ans[q.key] || ''); }).join('\n');
      var raw = await callAI(prompt, SUMMARY_SYSTEM, 'onboard-summary');
      setSummary(extractJSON(raw).summary || '');
      setStep('summary');
    } catch (e) { setError(friendly(e)); }
    setBusy(false);
  }

  async function submitFollowup(val) {
    var answer = (val || inputVal).trim();
    if (!answer) return;
    var newConvo = conversation.concat([{ role: 'q', text: aiQuestion || 'Tell me more' }, { role: 'a', text: answer }]);
    setConversation(newConvo);
    setInputVal('');
    await evalFollowup(newConvo);
  }

  async function evalFollowup(convo) {
    setBusy(true); setError(null);
    try {
      var text = compactTranscript(convo);
      var raw = await callAI('Product: ' + name + '\n\nFull transcript so far:\n' + text + '\n\nWhat is the next gap to fill, or is this enough?', EVAL_SYSTEM, 'onboard-eval');
      var res = extractJSON(raw);
      var asked = convo.length / 2; // follow-ups answered so far
      if (res.level === 'full' || asked >= MAX_FOLLOWUPS) {
        setReadinessLevel('full');
        setAiQuestion(null);
        setProgress(100);
        setStep('market');
      } else {
        setReadinessLevel(res.level || 'social');
        setAiQuestion(res.question || 'Anything else important about your product?');
        setAiWhy(res.why || '');
        // Monotonic: the AI's estimate wobbles between calls, so never go backward.
        if (typeof res.progress === 'number') setProgress(function (prev) { return Math.max(prev, res.progress); });
        setWhyOpen(false);
        setStep('followups');
      }
    } catch (e) { setError(friendly(e)); }
    setBusy(false);
  }

  async function submitMarket() {
    if (!inputVal.trim()) return;
    var next = Object.assign({}, marketAnswers);
    next[MARKET_QUESTIONS[marketIndex].key] = inputVal.trim();
    setMarketAnswers(next);
    setInputVal('');
    setWhyOpen(false);
    if (marketIndex < MARKET_QUESTIONS.length - 1) {
      setMarketIndex(marketIndex + 1);
    } else {
      await generateAll(next);
    }
  }

  async function generateAll(market) {
    setStep('generating'); setBusy(true); setError(null);
    try {
      var marketText = MARKET_QUESTIONS.map(function (q) { return q.label + ' ' + (market[q.key] || ''); }).join('\n');
      var prompt = 'Product name (never name it in social content): ' + name + '\n\n' + convoText()
        + '\n\nMarket answers:\n' + marketText
        + (toneExamples ? '\n\nTone examples from the founder:\n' + toneExamples : '');
      var raw = await callAI(prompt, GENERATE_SYSTEM, 'onboard-generate');
      var r = extractJSON(raw);
      setContext(r.context || '');
      setSubsText((r.subreddits || []).join(', '));
      setKwText((r.keywords || []).join(', '));
      setAsoText((r.asoKeywords || []).join(', '));
      setMarketGrade(r.marketGrade || '');
      setMarketReasoning(r.marketReasoning || '');

      // Previews (best-effort — failure shouldn't block onboarding)
      try {
        var praw = await callAI('Context:\n' + (r.context || '').slice(0, 2500), PREVIEW_SYSTEM, 'onboard-preview');
        setPreviews(extractJSON(praw));
      } catch (pe) { setPreviews(null); }

      setStep('review');
    } catch (e) {
      setError(friendly(e));
      setStep('market');
    }
    setBusy(false);
  }

  function handleSave() {
    onSave({
      name: name.trim() || 'Campaign',
      context: context.trim(),
      subs: parseList(subsText),
      keywords: parseList(kwText),
      asoKeywords: parseList(asoText),
      appStoreId: appStoreId.trim(),
      playPackage: playPackage.trim(),
      toneExamples: toneExamples,
      answers: answers,
      market: {
        answers: marketAnswers,
        grade: marketGrade,
        reasoning: marketReasoning,
      },
      createdAt: existingCampaign ? existingCampaign.createdAt : Date.now(),
      updatedAt: Date.now(),
    });
  }

  // ── Shared UI bits ──
  function Busy(label) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center', padding: 40 }}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={{ color: colors.textSecondary, marginTop: 16, fontSize: 14, textAlign: 'center', lineHeight: 22 }}>{label}</Text>
      </View>
    );
  }

  function field(labelText, hint, value, setter, opts) {
    opts = opts || {};
    return (
      <View style={{ marginBottom: 16 }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>{labelText}</Text>
        {hint ? <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 6 }}>{hint}</Text> : null}
        <TextInput
          style={{
            backgroundColor: colors.inputBg, borderColor: colors.inputBorder, borderWidth: 1,
            borderRadius: 8, padding: 12, fontSize: 14, color: colors.text,
            minHeight: opts.tall ? 120 : 44, textAlignVertical: 'top', lineHeight: 20,
          }}
          value={value}
          onChangeText={setter}
          multiline={!!opts.tall || !!opts.multiline}
          placeholder={opts.placeholder || ''}
          placeholderTextColor={colors.textMuted}
          autoCapitalize={opts.autoCap || 'sentences'}
          autoCorrect={opts.autoCorrect !== false}
        />
      </View>
    );
  }

  if (busy && (step === 'generating')) return Busy('Building your context, keywords, and market grade for ' + name + '...');
  if (busy && step === 'link') return Busy('Reading your listing...');
  if (busy && (step === 'core' || step === 'summary' || step === 'followups' || step === 'market')) return Busy('Thinking...');

  // ── STEP: name ──
  if (step === 'name') {
    return (
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
          <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: 8 }}>New Campaign</Text>
          <Text style={{ color: colors.textMuted, fontSize: 14, marginBottom: 24, lineHeight: 20 }}>What product or service is this campaign for?</Text>
          <TextInput
            style={{ backgroundColor: colors.inputBg, borderColor: colors.inputBorder, borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 17, color: colors.text }}
            placeholder="e.g. MyApp" placeholderTextColor={colors.textMuted}
            value={name} onChangeText={setName} autoFocus returnKeyType="next"
            onSubmitEditing={function () { if (name.trim()) setStep('link'); }}
          />
          <View style={{ flexDirection: 'row', marginTop: 20, gap: 10 }}>
            <TouchableOpacity onPress={onCancel} style={{ padding: 14, borderRadius: 10, backgroundColor: colors.card2, flex: 1, alignItems: 'center' }}>
              <Text style={{ color: colors.textSecondary, fontWeight: '600', fontSize: 15 }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={function () { if (name.trim()) setStep('link'); }}
              style={{ padding: 14, borderRadius: 10, flex: 2, alignItems: 'center', backgroundColor: name.trim() ? colors.primary : colors.card2 }}>
              <Text style={{ color: name.trim() ? '#fff' : colors.textMuted, fontWeight: '600', fontSize: 15 }}>Next</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={function () { setStep('review'); }} style={{ padding: 16, alignItems: 'center', marginTop: 12 }}>
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>Skip. I'll write my own context.</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // ── STEP: app link (bootstrap context from a store listing) ──
  if (step === 'link') {
    return (
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          {topNav(function () { setStep('name'); })}
          <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '600', marginBottom: 8 }}>{name}</Text>
          <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginBottom: 8, lineHeight: 24 }}>
            Have an App Store listing?
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 13, marginBottom: 16, lineHeight: 19 }}>
            Paste the link and I'll read your title and description to learn the features and benefits — far fewer questions. (Google Play can't be read automatically; paste your description instead.)
          </Text>
          {error ? <Text style={{ color: colors.red, fontSize: 12, marginBottom: 10 }}>{error}</Text> : null}

          <TextInput
            style={{ backgroundColor: colors.inputBg, borderColor: colors.inputBorder, borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 14, color: colors.text, marginBottom: 12 }}
            placeholder="https://apps.apple.com/app/id1234567890"
            placeholderTextColor={colors.textMuted}
            value={appLink} onChangeText={setAppLink}
            autoCapitalize="none" autoCorrect={false} keyboardType="url"
          />
          <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 6 }}>Or paste your store description:</Text>
          <TextInput
            style={{ backgroundColor: colors.inputBg, borderColor: colors.inputBorder, borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 14, color: colors.text, minHeight: 100, textAlignVertical: 'top', marginBottom: 16 }}
            placeholder="Paste your App Store / Play description here..."
            placeholderTextColor={colors.textMuted}
            value={pastedDesc} onChangeText={setPastedDesc} multiline
          />

          <TouchableOpacity onPress={readListing}
            disabled={!appLink.trim() && !pastedDesc.trim()}
            style={{ padding: 14, borderRadius: 10, alignItems: 'center', backgroundColor: (appLink.trim() || pastedDesc.trim()) ? colors.primary : colors.card2 }}>
            <Text style={{ color: (appLink.trim() || pastedDesc.trim()) ? '#fff' : colors.textMuted, fontWeight: '600', fontSize: 15 }}>Read it & continue</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={function () { setError(null); setStep('core'); }} style={{ padding: 16, alignItems: 'center', marginTop: 6 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 14, fontWeight: '600' }}>No listing — answer questions instead</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={function () { setStep('review'); }} style={{ padding: 10, alignItems: 'center' }}>
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>Skip. I'll write my own context.</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── STEP: core questions (one at a time) ──
  if (step === 'core') {
    var cq = CORE_QUESTIONS[coreIndex];
    var cqOk = inputVal.trim().length >= coreMin(cq.key);
    return (
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          {topNav(null)}
          <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '600', marginBottom: 6 }}>{name}</Text>
          <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 16 }}>Question {coreIndex + 1} of {CORE_QUESTIONS.length}</Text>
          {questionBlock(cq.label, cq.why)}
          {error ? <Text style={{ color: colors.red, fontSize: 12, marginBottom: 10 }}>{error}</Text> : null}
          <TextInput
            style={{ backgroundColor: colors.inputBg, borderColor: colors.inputBorder, borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 15, color: colors.text, minHeight: 140, textAlignVertical: 'top' }}
            placeholder={cq.placeholder} placeholderTextColor={colors.textMuted}
            multiline maxLength={6000} value={inputVal} onChangeText={setInputVal} autoFocus
          />
          {charHint(coreMin(cq.key))}
          <View style={{ flexDirection: 'row', marginTop: 16, gap: 10 }}>
            <TouchableOpacity onPress={function () {
              if (coreIndex > 0) { setCoreIndex(coreIndex - 1); setInputVal(answers[CORE_QUESTIONS[coreIndex - 1].key] || ''); }
              else { setStep('link'); }
            }} style={{ padding: 14, borderRadius: 10, backgroundColor: colors.card2, flex: 1, alignItems: 'center' }}>
              <Text style={{ color: colors.textSecondary, fontWeight: '600', fontSize: 15 }}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={submitCore} disabled={!cqOk}
              style={{ padding: 14, borderRadius: 10, flex: 2, alignItems: 'center', backgroundColor: cqOk ? colors.primary : colors.card2 }}>
              <Text style={{ color: cqOk ? '#fff' : colors.textMuted, fontWeight: '600', fontSize: 15 }}>Next</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={function () { setStep('review'); }} style={{ padding: 16, alignItems: 'center', marginTop: 12 }}>
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>Skip. I'll write my own context.</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── STEP: summary reflect-back ──
  if (step === 'summary') {
    return (
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          {topNav(function () { setStep(bootstrapText ? 'link' : 'core'); })}
          <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '600', marginBottom: 12 }}>{name}</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 8 }}>Here's what I understand:</Text>
          <View style={{ backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 16 }}>
            <TextInput
              style={{ color: colors.text, fontSize: 14, lineHeight: 21, padding: 0 }}
              value={summary} onChangeText={setSummary} multiline
            />
          </View>
          <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 16 }}>You can edit the summary above if anything's off, then continue.</Text>
          <TouchableOpacity onPress={function () { evalFollowup(conversation); }}
            style={{ padding: 14, borderRadius: 10, alignItems: 'center', backgroundColor: colors.primary }}>
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15 }}>Looks good — keep going</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── STEP: follow-ups (one targeted AI question at a time) ──
  if (step === 'followups') {
    return (
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          {topNav(function () { setStep('summary'); })}
          <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '600', marginBottom: 12 }}>{name}</Text>
          {progressBar()}
          {questionBlock(aiQuestion, aiWhy)}
          {error ? <Text style={{ color: colors.red, fontSize: 12, marginBottom: 10 }}>{error}</Text> : null}
          <TextInput
            style={{ backgroundColor: colors.inputBg, borderColor: colors.inputBorder, borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 15, color: colors.text, minHeight: 140, textAlignVertical: 'top' }}
            placeholder="Your answer..." placeholderTextColor={colors.textMuted}
            multiline maxLength={6000} value={inputVal} onChangeText={setInputVal} autoFocus
          />
          {charHint(FOLLOWUP_MIN)}
          <TouchableOpacity onPress={function () { submitFollowup(); }} disabled={inputVal.trim().length < FOLLOWUP_MIN}
            style={{ padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 16, backgroundColor: inputVal.trim().length >= FOLLOWUP_MIN ? colors.primary : colors.card2 }}>
            <Text style={{ color: inputVal.trim().length >= FOLLOWUP_MIN ? '#fff' : colors.textMuted, fontWeight: '600', fontSize: 15 }}>Next</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={function () { setAiQuestion(null); setStep('market'); }} style={{ padding: 16, alignItems: 'center', marginTop: 8 }}>
            <Text style={{ color: colors.textMuted, fontSize: 13 }}>Good enough — continue to market questions</Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── STEP: market questions (required, one at a time) ──
  if (step === 'market') {
    var mq = MARKET_QUESTIONS[marketIndex];
    return (
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          {topNav(null)}
          <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '600', marginBottom: 8 }}>{name}</Text>
          <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 12 }}>A few more questions to assess your market opportunity.</Text>
          {progressBar()}
          {questionBlock(mq.label, mq.why)}
          {error ? <Text style={{ color: colors.red, fontSize: 12, marginBottom: 10 }}>{error}</Text> : null}
          <TextInput
            style={{ backgroundColor: colors.inputBg, borderColor: colors.inputBorder, borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 15, color: colors.text, minHeight: 140, textAlignVertical: 'top' }}
            placeholder={mq.placeholder} placeholderTextColor={colors.textMuted}
            multiline maxLength={6000} value={inputVal} onChangeText={setInputVal} autoFocus
          />
          {charHint(MARKET_MIN)}
          <View style={{ flexDirection: 'row', marginTop: 16, gap: 10 }}>
            <TouchableOpacity onPress={function () {
              if (marketIndex > 0) { setMarketIndex(marketIndex - 1); setInputVal(marketAnswers[MARKET_QUESTIONS[marketIndex - 1].key] || ''); }
              else { setStep('summary'); }
            }} style={{ padding: 14, borderRadius: 10, backgroundColor: colors.card2, flex: 1, alignItems: 'center' }}>
              <Text style={{ color: colors.textSecondary, fontWeight: '600', fontSize: 15 }}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={submitMarket} disabled={inputVal.trim().length < MARKET_MIN}
              style={{ padding: 14, borderRadius: 10, flex: 2, alignItems: 'center', backgroundColor: inputVal.trim().length >= MARKET_MIN ? colors.primary : colors.card2 }}>
              <Text style={{ color: inputVal.trim().length >= MARKET_MIN ? '#fff' : colors.textMuted, fontWeight: '600', fontSize: 15 }}>
                {marketIndex < MARKET_QUESTIONS.length - 1 ? 'Next' : 'Generate'}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── STEP: review (editable context document + previews) ──
  var gradeColor = marketGrade && 'AB'.indexOf(marketGrade[0]) >= 0 ? colors.green
    : marketGrade && 'C'.indexOf(marketGrade[0]) >= 0 ? colors.accent
    : marketGrade ? colors.red : colors.textMuted;
  var canSave = name.trim() && context.trim() && parseList(subsText).length > 0 && parseList(kwText).length > 0;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 16 }}>{isEdit ? 'Edit Campaign' : (name || 'Campaign')}</Text>
        {error ? <View style={{ padding: 12, backgroundColor: colors.redDim, borderRadius: 8, marginBottom: 16 }}><Text style={{ color: colors.red, fontSize: 13 }}>{error}</Text></View> : null}

        {/* Market grade */}
        {marketGrade ? (
          <View style={{ backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <View style={{ backgroundColor: gradeColor, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 }}>
                <Text style={{ color: '#000', fontSize: 16, fontWeight: '800' }}>{marketGrade}</Text>
              </View>
              <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600' }}>Market Potential</Text>
            </View>
            <Text style={{ color: colors.textSecondary, fontSize: 12, lineHeight: 18 }}>{marketReasoning}</Text>
            <Text style={{ color: colors.textMuted, fontSize: 10, marginTop: 6 }}>Based on the context you provided and general signals. Validate with your own research.</Text>
          </View>
        ) : null}

        {/* Previews */}
        {previews ? (
          <View style={{ backgroundColor: colors.card2, borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: '700', marginBottom: 8 }}>Sample outputs from this context</Text>
            {previews.redditReply ? (
              <View style={{ marginBottom: 10 }}>
                <Text style={{ color: colors.textMuted, fontSize: 10, fontWeight: '600', marginBottom: 2 }}>REDDIT REPLY</Text>
                <Text style={{ color: colors.text, fontSize: 12, lineHeight: 17 }}>{previews.redditReply}</Text>
              </View>
            ) : null}
            {previews.xPost ? (
              <View>
                <Text style={{ color: colors.textMuted, fontSize: 10, fontWeight: '600', marginBottom: 2 }}>X POST</Text>
                <Text style={{ color: colors.text, fontSize: 12, lineHeight: 17 }}>{previews.xPost}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {field('Campaign Name', null, name, setName, { placeholder: 'Campaign name' })}
        {field('Context Document', 'The ground truth for everything the AI generates. The richer, the better.', context, setContext, { tall: true, placeholder: 'Describe your product, audience, differentiation, voice...' })}
        {field('Subreddits', parseList(subsText).length + ' subreddits (comma-separated)', subsText, setSubsText, { multiline: true, placeholder: 'personalfinance, budgeting', autoCap: 'none', autoCorrect: false })}
        {field('Reddit Keywords', parseList(kwText).length + ' pain-language phrases for finding discussions', kwText, setKwText, { multiline: true, placeholder: 'paycheck to paycheck, broke before payday', autoCap: 'none', autoCorrect: false })}
        {field('ASO Keywords', parseList(asoText).length + ' App Store search terms for rank tracking', asoText, setAsoText, { multiline: true, placeholder: 'budget app, cash flow, bill tracker', autoCap: 'none', autoCorrect: false })}
        {field('App Store ID', 'Numeric id from your App Store URL (for iOS rank tracking)', appStoreId, setAppStoreId, { placeholder: 'e.g. 1234567890', autoCap: 'none', autoCorrect: false })}
        {field('Play Package Name', 'Android package (for later Android rank tracking)', playPackage, setPlayPackage, { placeholder: 'com.sheffco.myapp', autoCap: 'none', autoCorrect: false })}
        {field('Your Tone Examples', 'Paste real comments/posts you\'ve written so the AI matches your voice', toneExamples, setToneExamples, { tall: true, placeholder: 'Paste a few things you\'ve actually written...' })}

        <TouchableOpacity onPress={handleSave} disabled={!canSave}
          style={{ padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 8, backgroundColor: canSave ? colors.primary : colors.card2 }}>
          <Text style={{ color: canSave ? '#fff' : colors.textMuted, fontWeight: '700', fontSize: 16 }}>Save Campaign</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onCancel} style={{ padding: 14, alignItems: 'center', marginTop: 10 }}>
          <Text style={{ color: colors.textMuted, fontSize: 14 }}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
