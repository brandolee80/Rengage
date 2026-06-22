import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';

var INITIAL_QUESTIONS = [
  { key: 'whatItDoes', label: 'What does your product do?', placeholder: 'e.g. 60-day cash flow forecasting app for iOS, shows daily projected balance' },
  { key: 'whoItsFor', label: 'Who is it for?', placeholder: 'e.g. People living paycheck to paycheck who hate traditional budgeting' },
  { key: 'howItsDifferent', label: 'How is it different from alternatives?', placeholder: 'e.g. No bank login, no subscription, $4.99 one-time, forecasting not budgeting' },
  { key: 'toneExamples', label: 'Paste 2-3 Reddit comments you\'ve written (so AI can match your voice)', placeholder: 'Paste actual comments you\'ve posted. The AI will learn your tone, sentence length, and style from these.' },
];

var MAX_ROUNDS = 8;

var EVAL_SYSTEM = 'You are helping build an AI context profile for a product. You will receive answers about a product. Your job is to decide if you have enough information to write detailed operational instructions for an AI that will both score Reddit post relevance and draft comments.\n\nYou need solid answers for ALL of these:\n1. What does the product specifically do? (features, mechanics, user experience)\n2. Who is the target user and what exact problem does it solve?\n3. How is it different from alternatives? (price, approach, what it avoids)\n4. Writing style examples from the user\n\nIf ANY of those are vague, generic, or missing, ask ONE specific follow-up question to fill that gap. Be direct.\n\nRespond with JSON only:\n- If you need more info: {"ready":false,"question":"your follow-up question"}\n- If you have enough: {"ready":true}\n\nOutput ONLY the JSON object.';

var GENERATE_SYSTEM = 'You are helping build a Reddit engagement tool. The user has described their product and provided example comments showing their writing style.\n\nGenerate an AI context document that serves TWO purposes:\n\n1. RELEVANCE SCORING: Help determine which Reddit posts are good opportunities to engage. Include the specific problems the product solves, the exact audience pain points, and the language/phrases these users typically use when describing their struggles.\n\n2. COMMENT DRAFTING: Provide instructions for drafting Reddit comments. Include:\n   - What the product does, key features, price, how it works\n   - What makes it different from alternatives\n   - The creator\'s background and credibility\n   - Rules: always answer the person\'s question first, only mention the product when directly relevant, frame as personal experience, never use marketing language, keep product mentions to 1-2 sentences max, if the post isn\'t a natural fit just be helpful\n   - WRITING STYLE: Based on the example comments provided, describe the user\'s tone, sentence structure, punctuation habits, level of formality, and any distinctive patterns. The AI should draft comments that sound like this specific person wrote them.\n\nAlso generate subreddits to monitor and keywords to track (focus on pain language the audience uses, not product features).\n\nReturn as JSON: {"context":"the full AI context","subreddits":["sub1","sub2"],"keywords":["keyword1","keyword2"]}\nOutput ONLY the JSON object.';

export default function CampaignSetup({ colors, onSave, onCancel, existingCampaign, callAI }) {
  var isEdit = !!existingCampaign;

  // Step: 'name', 'questions', 'generating', 'review'
  var [step, setStep] = useState(isEdit ? 'review' : 'name');

  // Campaign data
  var [name, setName] = useState(isEdit ? existingCampaign.name : '');
  var [context, setContext] = useState(isEdit ? existingCampaign.context : '');
  var [subsText, setSubsText] = useState(isEdit ? (existingCampaign.subs || []).join(', ') : '');
  var [kwText, setKwText] = useState(isEdit ? (existingCampaign.keywords || []).join(', ') : '');

  // AI builder state
  var [qIndex, setQIndex] = useState(0);
  var [answers, setAnswers] = useState(isEdit ? (existingCampaign.answers || {}) : {});
  var [inputVal, setInputVal] = useState('');
  var [aiQuestion, setAiQuestion] = useState(null);
  var [conversation, setConversation] = useState([]);
  var [generating, setGenerating] = useState(false);
  var [error, setError] = useState(null);

  function parseList(str) {
    return str.split(/[,\n]+/).map(function (s) { return s.replace(/^r\//i, '').trim(); }).filter(function (s) { return s.length > 0; });
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

  // ── AI flow handlers ──

  async function handleNext() {
    if (!inputVal.trim()) return;
    var val = inputVal.trim();
    setInputVal('');

    if (qIndex < INITIAL_QUESTIONS.length) {
      var updated = Object.assign({}, answers);
      updated[INITIAL_QUESTIONS[qIndex].key] = val;
      setAnswers(updated);

      var newConvo = conversation.concat([
        { role: 'q', text: INITIAL_QUESTIONS[qIndex].label },
        { role: 'a', text: val },
      ]);
      setConversation(newConvo);

      if (qIndex < INITIAL_QUESTIONS.length - 1) {
        setQIndex(qIndex + 1);
      } else {
        await evaluateAndContinue(newConvo, updated);
      }
    } else {
      var newConvo2 = conversation.concat([
        { role: 'q', text: aiQuestion },
        { role: 'a', text: val },
      ]);
      setConversation(newConvo2);
      await evaluateAndContinue(newConvo2, answers);
    }
  }

  async function evaluateAndContinue(convo, ans) {
    if (convo.length / 2 >= MAX_ROUNDS) {
      await doGenerate(convo);
      return;
    }

    setGenerating(true);
    setError(null);
    try {
      var convoText = convo.map(function (c) { return (c.role === 'q' ? 'Q: ' : 'A: ') + c.text; }).join('\n');
      // Truncate to last 3000 chars to limit token usage
      if (convoText.length > 3000) convoText = convoText.slice(-3000);
      var prompt = 'Product name: ' + name + '\n\n' + convoText + '\n\nDo you have enough to write the context, or do you need to ask another question?';

      var raw = await callAI(prompt, EVAL_SYSTEM, 'context-eval');
      var result = extractJSON(raw);

      if (result.ready) {
        await doGenerate(convo);
      } else {
        setAiQuestion(result.question);
        setQIndex(qIndex + 1);
        setGenerating(false);
      }
    } catch (e) {
      setError(e.message);
      setGenerating(false);
    }
  }

  async function doGenerate(convo) {
    setStep('generating');
    setGenerating(true);
    setError(null);
    try {
      var convoText = convo.map(function (c) { return (c.role === 'q' ? 'Q: ' : 'A: ') + c.text; }).join('\n');
      var prompt = 'Product name (never mention in comments): ' + name + '\n\n' + convoText;

      var raw = await callAI(prompt, GENERATE_SYSTEM, 'context-generate');
      var result = extractJSON(raw);

      setContext(result.context || '');
      setSubsText((result.subreddits || []).join(', '));
      setKwText((result.keywords || []).join(', '));
      setStep('review');
    } catch (e) {
      setError(e.message);
      setStep('questions');
    }
    setGenerating(false);
  }

  function handleSave() {
    onSave({
      name: name.trim() || 'Campaign',
      context: context.trim(),
      subs: parseList(subsText),
      keywords: parseList(kwText),
      answers: answers,
      createdAt: existingCampaign ? existingCampaign.createdAt : Date.now(),
      updatedAt: Date.now(),
    });
  }

  // ── STEP: Name ──
  if (step === 'name') {
    return (
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
          <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: 8 }}>
            New Campaign
          </Text>
          <Text style={{ color: colors.textMuted, fontSize: 14, marginBottom: 24, lineHeight: 20 }}>
            What product or service is this campaign for?
          </Text>
          <TextInput
            style={{
              backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
              borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 17,
              color: colors.text,
            }}
            placeholder="e.g. NXT60"
            placeholderTextColor={colors.textMuted}
            value={name}
            onChangeText={setName}
            autoFocus
            returnKeyType="next"
            onSubmitEditing={function () {
              if (name.trim()) setStep('questions');
            }}
          />
          <View style={{ flexDirection: 'row', marginTop: 20, gap: 10 }}>
            <TouchableOpacity
              onPress={onCancel}
              style={{ padding: 14, borderRadius: 10, backgroundColor: colors.card2, flex: 1, alignItems: 'center' }}
            >
              <Text style={{ color: colors.textSecondary, fontWeight: '600', fontSize: 15 }}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={function () { if (name.trim()) setStep('questions'); }}
              style={{
                padding: 14, borderRadius: 10, flex: 2, alignItems: 'center',
                backgroundColor: name.trim() ? colors.primary : colors.card2,
              }}
            >
              <Text style={{ color: name.trim() ? '#fff' : colors.textMuted, fontWeight: '600', fontSize: 15 }}>
                Next
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  }

  // ── STEP: Generating ──
  if (step === 'generating') {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center', padding: 40 }}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={{ color: colors.textSecondary, marginTop: 16, fontSize: 15, textAlign: 'center', lineHeight: 22 }}>
          Generating context, subreddits,{'\n'}and keywords for {name}...
        </Text>
      </View>
    );
  }

  // ── STEP: AI Questions ──
  if (step === 'questions') {
    var currentLabel = qIndex < INITIAL_QUESTIONS.length
      ? INITIAL_QUESTIONS[qIndex].label
      : aiQuestion;
    var currentPlaceholder = qIndex < INITIAL_QUESTIONS.length
      ? INITIAL_QUESTIONS[qIndex].placeholder
      : 'Your answer...';

    if (generating && step === 'questions') {
      return (
        <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center', padding: 40 }}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={{ color: colors.textSecondary, marginTop: 16, fontSize: 14, textAlign: 'center' }}>
            Thinking...
          </Text>
        </View>
      );
    }

    return (
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          {/* Campaign name header */}
          <Text style={{ color: colors.primary, fontSize: 13, fontWeight: '600', marginBottom: 16 }}>
            {name}
          </Text>

          {/* Previous Q&A */}
          {conversation.map(function (c, i) {
            if (c.role === 'q') {
              return (
                <Text key={i} style={{ color: colors.textMuted, fontSize: 12, marginBottom: 2, marginTop: i > 0 ? 10 : 0 }}>
                  {c.text}
                </Text>
              );
            }
            return (
              <View key={i} style={{ backgroundColor: colors.card2, borderRadius: 8, padding: 10, marginBottom: 4 }}>
                <Text style={{ color: colors.textSecondary, fontSize: 13, lineHeight: 18 }}>{c.text}</Text>
              </View>
            );
          })}

          {/* Current question */}
          <View style={{ marginTop: conversation.length > 0 ? 20 : 0 }}>
            <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600', marginBottom: 14, lineHeight: 24 }}>
              {currentLabel}
            </Text>

            {error ? (
              <View style={{ padding: 10, backgroundColor: colors.redDim, borderRadius: 8, marginBottom: 12 }}>
                <Text style={{ color: colors.red, fontSize: 12 }}>{error}</Text>
              </View>
            ) : null}

            <TextInput
              style={{
                backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
                borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 15,
                color: colors.text, minHeight: 80, textAlignVertical: 'top',
              }}
              placeholder={currentPlaceholder}
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={500}
              value={inputVal}
              onChangeText={setInputVal}
              autoFocus
            />

            <View style={{ flexDirection: 'row', marginTop: 16, gap: 10 }}>
              <TouchableOpacity
                onPress={function () {
                  if (qIndex > 0) {
                    var prevConvo = conversation.slice(0, -2);
                    setConversation(prevConvo);
                    setQIndex(qIndex - 1);
                    if (qIndex - 1 < INITIAL_QUESTIONS.length) {
                      setInputVal(answers[INITIAL_QUESTIONS[qIndex - 1].key] || '');
                    } else {
                      setInputVal('');
                    }
                  } else {
                    setStep('name');
                  }
                }}
                style={{ padding: 14, borderRadius: 10, backgroundColor: colors.card2, flex: 1, alignItems: 'center' }}
              >
                <Text style={{ color: colors.textSecondary, fontWeight: '600', fontSize: 15 }}>Back</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleNext}
                style={{
                  padding: 14, borderRadius: 10, flex: 2, alignItems: 'center',
                  backgroundColor: inputVal.trim() ? colors.primary : colors.card2,
                }}
              >
                <Text style={{ color: inputVal.trim() ? '#fff' : colors.textMuted, fontWeight: '600', fontSize: 15 }}>
                  Next
                </Text>
              </TouchableOpacity>
            </View>

            {/* Skip to manual - always visible at bottom */}
            <TouchableOpacity
              onPress={function () { setStep('review'); }}
              style={{ padding: 16, alignItems: 'center', marginTop: 20 }}
            >
              <Text style={{ color: colors.textMuted, fontSize: 13 }}>Skip. I'll add my own context.</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── STEP: Review / Manual Entry ──
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={{ flex: 1, padding: 20 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 20 }}>
          {isEdit ? 'Edit Campaign' : name || 'Campaign'}
        </Text>

        {error ? (
          <View style={{ padding: 12, backgroundColor: colors.redDim, borderRadius: 8, marginBottom: 16 }}>
            <Text style={{ color: colors.red, fontSize: 13 }}>{error}</Text>
          </View>
        ) : null}

        {/* Name */}
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 6 }}>Campaign Name</Text>
        <TextInput
          style={{
            backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
            borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 15,
            color: colors.text, marginBottom: 16,
          }}
          value={name}
          onChangeText={setName}
          placeholder="Campaign name"
          placeholderTextColor={colors.textMuted}
        />

        {/* Context */}
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>AI Context</Text>
        <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 6 }}>
          How the AI should talk about your product. Be specific and natural.
        </Text>
        <TextInput
          style={{
            backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
            borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 14,
            color: colors.text, marginBottom: 16, minHeight: 120, textAlignVertical: 'top',
            lineHeight: 20,
          }}
          value={context}
          onChangeText={setContext}
          multiline
          placeholder="Describe your product as a real user would..."
          placeholderTextColor={colors.textMuted}
        />

        {/* Subreddits */}
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>Subreddits</Text>
        <TextInput
          style={{
            backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
            borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 14,
            color: colors.text, marginBottom: 4, minHeight: 50, textAlignVertical: 'top',
          }}
          value={subsText}
          onChangeText={setSubsText}
          multiline
          placeholder="personalfinance, ynab, budgeting"
          placeholderTextColor={colors.textMuted}
        />
        <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 16 }}>
          Comma-separated. {parseList(subsText).length} subreddits.
        </Text>

        {/* Keywords */}
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>Keywords</Text>
        <TextInput
          style={{
            backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
            borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 14,
            color: colors.text, marginBottom: 4, minHeight: 50, textAlignVertical: 'top',
          }}
          value={kwText}
          onChangeText={setKwText}
          multiline
          placeholder="budgeting app, cash flow, paycheck to paycheck"
          placeholderTextColor={colors.textMuted}
        />
        <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 16 }}>
          Comma-separated. {parseList(kwText).length} keywords.
        </Text>

        {/* Save */}
        <TouchableOpacity
          onPress={handleSave}
          disabled={!name.trim() || !context.trim() || parseList(subsText).length === 0 || parseList(kwText).length === 0}
          style={{
            padding: 14, borderRadius: 10, alignItems: 'center', marginTop: 8,
            backgroundColor: (name.trim() && context.trim() && parseList(subsText).length > 0 && parseList(kwText).length > 0) ? colors.primary : colors.card2,
          }}
        >
          <Text style={{
            color: (name.trim() && context.trim() && parseList(subsText).length > 0 && parseList(kwText).length > 0) ? '#fff' : colors.textMuted,
            fontWeight: '700', fontSize: 16,
          }}>Save Campaign</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={onCancel}
          style={{ padding: 14, alignItems: 'center', marginTop: 10, marginBottom: 40 }}
        >
          <Text style={{ color: colors.textMuted, fontSize: 14 }}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
