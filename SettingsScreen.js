import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, TextInput, ScrollView, Alert, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { getAiBudget, getAiConfig, setAiConfig, getUsage } from './ai';
import { loadActionItems, loadMetrics } from './marketing';
import store from './store';

export default function SettingsScreen({ colors, campaigns, isDark, toggleTheme, username, onSaveUsername, apiKey, onSaveApiKey, postLog, purgeDays, onSavePurgeDays, repollMinutes, onSaveRepollMinutes, inboxUrl, onSaveInboxUrl, rengageCooldownMins, onSaveCooldownMins, redditWeeklyTarget, onSaveRedditWeekly }) {
  var [keyInput, setKeyInput] = useState(apiKey || '');
  var [nameInput, setNameInput] = useState(username || '');
  var [inboxInput, setInboxInput] = useState(inboxUrl || '');
  var [inboxSaved, setInboxSaved] = useState(false);
  var [cooldownInput, setCooldownInput] = useState(String(rengageCooldownMins != null ? rengageCooldownMins : 5));
  var [redditWeeklyInput, setRedditWeeklyInput] = useState(String(redditWeeklyTarget != null ? redditWeeklyTarget : 5));
  var [taps, setTaps] = useState(0);
  var [devMode, setDevMode] = useState(false);

  useEffect(function () { store.get('rengage-devmode').then(function (v) { if (v) setDevMode(true); }); }, []);

  function tapTitle() {
    var n = taps + 1;
    setTaps(n);
    if (n >= 5 && !devMode) { setDevMode(true); store.set('rengage-devmode', true); Alert.alert('Developer Mode', 'Export tools enabled.'); }
  }

  async function buildExport() {
    var out = [];
    for (var i = 0; i < (campaigns || []).length; i++) {
      var c = campaigns[i];
      var actionItems = await loadActionItems(c.id);
      var metrics = await loadMetrics(c.id);
      out.push({
        name: c.name, market: c.market, includePaid: !!c.includePaid,
        subs: c.subs, keywords: c.keywords, asoKeywords: c.asoKeywords,
        appStoreId: c.appStoreId, context: c.context,
        actionItems: actionItems, metrics: metrics,
      });
    }
    return JSON.stringify(out, null, 2);
  }

  async function copyExport() {
    var json = await buildExport();
    await Clipboard.setStringAsync(json);
    Alert.alert('Copied', 'Context + action items copied. Paste into Claude to review the plan.');
  }

  async function shareExport() {
    var json = await buildExport();
    try { await Share.share({ message: json }); } catch (e) {}
  }

  function handleSaveRedditWeekly() {
    var n = parseInt(redditWeeklyInput) || 5;
    if (n < 1) n = 1;
    if (n > 200) n = 200;
    setRedditWeeklyInput(String(n));
    onSaveRedditWeekly(n);
  }

  function handleSaveCooldown() {
    var m = parseInt(cooldownInput);
    if (isNaN(m) || m < 0) m = 5;
    if (m > 1440) m = 1440;
    var save = function () { setCooldownInput(String(m)); onSaveCooldownMins(m); };
    if (m < 5) {
      Alert.alert(
        'Are you sure?',
        'A cooldown under 5 minutes lets you post several comments in quick succession. That looks like a bot and can get your account banned. Real engagement takes time to scroll, read, and write. Keep it this short anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Use ' + m + ' min anyway', style: 'destructive', onPress: save },
        ]
      );
    } else {
      save();
    }
  }
  var [purgeInput, setPurgeInput] = useState(String(purgeDays || 7));
  var [repollInput, setRepollInput] = useState(String(repollMinutes || 60));
  var [keySaved, setKeySaved] = useState(false);
  var [nameSaved, setNameSaved] = useState(false);
  var [budget, setBudget] = useState(null);
  var initCfg = {};
  try { initCfg = getAiConfig(); } catch (e) {}
  var [modelInput, setModelInput] = useState(initCfg.model || 'gemini-3.1-flash-lite');
  var [rpmInput, setRpmInput] = useState(String(initCfg.rpm || 15));
  var [rpdInput, setRpdInput] = useState(String(initCfg.rpd || 500));
  var [cfgSaved, setCfgSaved] = useState(false);

  useEffect(function () {
    getAiBudget().then(setBudget).catch(function () {});
  }, []);

  // Computed synchronously so it always renders (not gated on async state).
  var usageNow = null;
  try { usageNow = getUsage(); } catch (e) {}

  function handleSaveAiConfig() {
    var rpm = parseInt(rpmInput) || 15;
    if (rpm < 1) rpm = 1;
    if (rpm > 1000) rpm = 1000;
    var rpd = parseInt(rpdInput) || 500;
    if (rpd < 1) rpd = 1;
    if (rpd > 100000) rpd = 100000;
    var model = (modelInput || '').trim() || 'gemini-3.1-flash-lite';
    setRpmInput(String(rpm));
    setRpdInput(String(rpd));
    setModelInput(model);
    setAiConfig({ model: model, rpm: rpm, rpd: rpd }).then(function () {
      getAiBudget().then(setBudget).catch(function () {});
      setCfgSaved(true);
      setTimeout(function () { setCfgSaved(false); }, 2000);
    });
  }

  function handleSaveKey() {
    onSaveApiKey(keyInput.trim());
    setKeySaved(true);
    setTimeout(function () { setKeySaved(false); }, 2000);
  }

  function handleSaveName() {
    onSaveUsername(nameInput.trim());
    setNameSaved(true);
    setTimeout(function () { setNameSaved(false); }, 2000);
  }

  function handleSaveInbox() {
    onSaveInboxUrl(inboxInput.trim());
    setInboxSaved(true);
    setTimeout(function () { setInboxSaved(false); }, 2000);
  }

  // Recent posting stats
  var oneDayAgo = Date.now() - 86400000;
  var todayPosts = (postLog || []).filter(function (p) { return p.at > oneDayAgo; });
  var subCounts = {};
  todayPosts.forEach(function (p) {
    subCounts[p.sub] = (subCounts[p.sub] || 0) + 1;
  });

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg, padding: 20 }}>
      <TouchableOpacity activeOpacity={1} onPress={tapTitle}>
        <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: 20 }}>Settings</Text>
      </TouchableOpacity>

      {/* Reddit Username */}
      <View style={{
        backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
        borderRadius: 12, padding: 16, marginBottom: 16,
      }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>Reddit Username</Text>
        <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 10 }}>
          Used to filter your own posts from results and track your comments
        </Text>
        <TextInput
          style={{
            backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
            borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 14,
            color: colors.text,
          }}
          value={nameInput}
          onChangeText={setNameInput}
          placeholder="your_username"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          onPress={handleSaveName}
          style={{
            backgroundColor: colors.primary, padding: 10, borderRadius: 8,
            alignItems: 'center', marginTop: 10,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>
            {nameSaved ? 'Saved!' : 'Save'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Follow-up inbox feed */}
      <View style={{
        backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
        borderRadius: 12, padding: 16, marginBottom: 16,
      }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>Follow-up Inbox Feed</Text>
        <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 10, lineHeight: 16 }}>
          Detects replies to you for the Follow-Ups tab (Reddit blocks the comment API, so this uses
          your private RSS feed instead). At reddit.com/prefs/feeds, copy your messages RSS URL (it has a
          private <Text style={{ color: colors.text }}>feed</Text> token). For just replies to your comments,
          change the path to <Text style={{ color: colors.text }}>/message/comments/.rss</Text>. Keep the token secret.
        </Text>
        <TextInput
          style={{
            backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
            borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 12,
            color: colors.text, fontFamily: 'monospace',
          }}
          value={inboxInput}
          onChangeText={setInboxInput}
          placeholder="https://www.reddit.com/message/comments/.rss?feed=...&user=..."
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          onPress={handleSaveInbox}
          style={{ backgroundColor: colors.primary, padding: 10, borderRadius: 8, alignItems: 'center', marginTop: 10 }}
        >
          <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>{inboxSaved ? 'Saved!' : 'Save Feed URL'}</Text>
        </TouchableOpacity>
      </View>

      {/* AI API Key */}
      <View style={{
        backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
        borderRadius: 12, padding: 16, marginBottom: 16,
      }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>AI API Key</Text>
        <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 10 }}>
          Gemini API key for reply drafting. Free at aistudio.google.com
        </Text>
        <TextInput
          style={{
            backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
            borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 13,
            color: colors.text, fontFamily: 'monospace',
          }}
          value={keyInput}
          onChangeText={setKeyInput}
          placeholder="AIza..."
          placeholderTextColor={colors.textMuted}
          secureTextEntry
          autoCapitalize="none"
        />
        <TouchableOpacity
          onPress={handleSaveKey}
          style={{
            backgroundColor: colors.primary, padding: 10, borderRadius: 8,
            alignItems: 'center', marginTop: 10,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>
            {keySaved ? 'Saved!' : 'Save Key'}
          </Text>
        </TouchableOpacity>
        <Text style={{ color: (budget && budget.used >= budget.limit) ? colors.red : colors.textMuted, fontSize: 11, marginTop: 10 }}>
          {budget
            ? 'AI calls today: ' + budget.used + ' / ' + budget.limit + (budget.used >= budget.limit ? ' — budget reached, using local scores' : '')
            : 'AI calls today: loading…'}
        </Text>
        {usageNow ? (
          <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 4 }}>
            All-time: {usageNow.calls} calls · {usageNow.totalPromptTokens + usageNow.totalResponseTokens} tokens
          </Text>
        ) : null}

        <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 12 }} />
        <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 4 }}>AI Model & Limits</Text>
        <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 8, lineHeight: 16 }}>
          RPM spaces out calls; RPD is the app's daily stop (when reached, posts keep their local
          score and get AI-scored automatically the next day). Set these to your model's free-tier limits.
          {'\n'}Recommended: <Text style={{ color: colors.text }}>gemini-3.1-flash-lite</Text> — 15 RPM / 500 RPD.
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 4 }}>Model id</Text>
        <TextInput
          style={{
            backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
            borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 13,
            color: colors.text, fontFamily: 'monospace', marginBottom: 8,
          }}
          value={modelInput}
          onChangeText={setModelInput}
          placeholder="gemini-3.1-flash-lite"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
          <View>
            <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 4 }}>RPM</Text>
            <TextInput
              style={{
                backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
                borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 14,
                color: colors.text, width: 64, textAlign: 'center',
              }}
              value={rpmInput}
              onChangeText={setRpmInput}
              keyboardType="number-pad"
            />
          </View>
          <View>
            <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 4 }}>RPD</Text>
            <TextInput
              style={{
                backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
                borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 14,
                color: colors.text, width: 72, textAlign: 'center',
              }}
              value={rpdInput}
              onChangeText={setRpdInput}
              keyboardType="number-pad"
            />
          </View>
          <TouchableOpacity
            onPress={handleSaveAiConfig}
            style={{ flex: 1, backgroundColor: colors.primary, padding: 11, borderRadius: 8, alignItems: 'center' }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>{cfgSaved ? 'Saved!' : 'Save AI Settings'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Posting Activity */}
      <View style={{
        backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
        borderRadius: 12, padding: 16, marginBottom: 16,
      }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 10 }}>Posting Activity (24h)</Text>
        {todayPosts.length === 0 ? (
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>No comments tracked today</Text>
        ) : (
          <View>
            <Text style={{ color: colors.text, fontSize: 13, marginBottom: 8 }}>
              {todayPosts.length} comments today
            </Text>
            {Object.keys(subCounts).map(function (sub) {
              var count = subCounts[sub];
              var warn = count >= 5;
              return (
                <View key={sub} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text style={{ color: warn ? colors.accent : colors.textMuted, fontSize: 12 }}>r/{sub}</Text>
                  <Text style={{ color: warn ? colors.accent : colors.text, fontSize: 12, fontWeight: '600' }}>
                    {count}{warn ? ' (slow down)' : ''}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </View>

      {/* Data Retention */}
      <View style={{
        backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
        borderRadius: 12, padding: 16, marginBottom: 16,
      }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>Data Retention</Text>
        <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 10 }}>
          Auto-purge posts older than this many days
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TextInput
            style={{
              backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
              borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 14,
              color: colors.text, width: 60, textAlign: 'center',
            }}
            value={purgeInput}
            onChangeText={setPurgeInput}
            keyboardType="number-pad"
          />
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>days</Text>
          <TouchableOpacity
            onPress={function () {
              var days = parseInt(purgeInput) || 7;
              if (days < 1) days = 1;
              if (days > 90) days = 90;
              setPurgeInput(String(days));
              onSavePurgeDays(days);
            }}
            style={{ backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>Save</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Reddit Engagement Goal */}
      <View style={{
        backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
        borderRadius: 12, padding: 16, marginBottom: 16,
      }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>Reddit Engagement Goal</Text>
        <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 10, lineHeight: 16 }}>
          Your weekly target for Reddit comments. Each comment counts toward this goal in your campaign's
          Effort Score (hitting the target = full engagement credit; extra comments don't inflate it).
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TextInput
            style={{
              backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
              borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 14,
              color: colors.text, width: 60, textAlign: 'center',
            }}
            value={redditWeeklyInput}
            onChangeText={setRedditWeeklyInput}
            keyboardType="number-pad"
          />
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>comments/week</Text>
          <TouchableOpacity
            onPress={handleSaveRedditWeekly}
            style={{ backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>Save</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Rengage Cooldown */}
      <View style={{
        backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
        borderRadius: 12, padding: 16, marginBottom: 16,
      }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>Rengage Cooldown</Text>
        <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 10, lineHeight: 16 }}>
          After you post a Reddit comment, all Rengage buttons stay disabled for this long. Posting several
          comments within seconds looks like a bot and risks a ban — real engagement takes time. Default 5 minutes.
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TextInput
            style={{
              backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
              borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 14,
              color: colors.text, width: 60, textAlign: 'center',
            }}
            value={cooldownInput}
            onChangeText={setCooldownInput}
            keyboardType="number-pad"
          />
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>minutes</Text>
          <TouchableOpacity
            onPress={handleSaveCooldown}
            style={{ backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>Save</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Source Polling */}
      <View style={{
        backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
        borderRadius: 12, padding: 16, marginBottom: 16,
      }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>Source Polling</Text>
        <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 10, lineHeight: 16 }}>
          Subreddits are polled one at a time (~1/min) while the app is open, so Reddit doesn't rate-limit you.
          Each source is re-polled at most once per this interval, and stays "fresh" (green) until it's due again.
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TextInput
            style={{
              backgroundColor: colors.inputBg, borderColor: colors.inputBorder,
              borderWidth: 1, borderRadius: 8, padding: 10, fontSize: 14,
              color: colors.text, width: 60, textAlign: 'center',
            }}
            value={repollInput}
            onChangeText={setRepollInput}
            keyboardType="number-pad"
          />
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>minutes</Text>
          <TouchableOpacity
            onPress={function () {
              var mins = parseInt(repollInput) || 60;
              if (mins < 5) mins = 5;
              if (mins > 1440) mins = 1440;
              setRepollInput(String(mins));
              onSaveRepollMinutes(mins);
            }}
            style={{ backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>Save</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Theme */}
      <View style={{
        backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
        borderRadius: 12, padding: 16, marginBottom: 16,
      }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 10 }}>Appearance</Text>
        <TouchableOpacity
          onPress={toggleTheme}
          style={{
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
            backgroundColor: colors.card2, padding: 12, borderRadius: 8,
          }}
        >
          <Text style={{ color: colors.text, fontSize: 14 }}>Dark Mode</Text>
          <Text style={{ color: colors.textSecondary, fontSize: 14 }}>{isDark ? 'On' : 'Off'}</Text>
        </TouchableOpacity>
      </View>

      {/* Developer (5-tap the title to enable) */}
      {devMode ? (
        <View style={{
          backgroundColor: colors.card, borderWidth: 1, borderColor: colors.accent,
          borderRadius: 12, padding: 16, marginBottom: 16,
        }}>
          <Text style={{ color: colors.accent, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>Developer · Export</Text>
          <Text style={{ color: colors.textMuted, fontSize: 11, marginBottom: 10, lineHeight: 16 }}>
            Export all campaigns' context + action items as JSON to review plan quality (paste into Claude).
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={copyExport} style={{ flex: 1, backgroundColor: colors.primary, padding: 11, borderRadius: 8, alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontWeight: '600', fontSize: 13 }}>Copy JSON</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={shareExport} style={{ flex: 1, backgroundColor: colors.card2, padding: 11, borderRadius: 8, alignItems: 'center' }}>
              <Text style={{ color: colors.text, fontWeight: '600', fontSize: 13 }}>Share</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={function () { setDevMode(false); setTaps(0); store.set('rengage-devmode', false); }} style={{ padding: 8, alignItems: 'center', marginTop: 6 }}>
            <Text style={{ color: colors.textMuted, fontSize: 12 }}>Disable dev mode</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* About */}
      <View style={{
        backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
        borderRadius: 12, padding: 16, marginBottom: 40,
      }}>
        <Text style={{ color: colors.textSecondary, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>About</Text>
        <Text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 18 }}>
          Rengage v1.0.0{'\n'}
          Reddit engagement command center{'\n'}
          Sheffco Studios
        </Text>
      </View>
    </ScrollView>
  );
}
