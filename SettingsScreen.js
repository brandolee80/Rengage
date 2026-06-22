import React, { useState } from 'react';
import { View, Text, TouchableOpacity, TextInput, ScrollView } from 'react-native';

export default function SettingsScreen({ colors, isDark, toggleTheme, username, onSaveUsername, apiKey, onSaveApiKey, postLog, purgeDays, onSavePurgeDays }) {
  var [keyInput, setKeyInput] = useState(apiKey || '');
  var [nameInput, setNameInput] = useState(username || '');
  var [purgeInput, setPurgeInput] = useState(String(purgeDays || 7));
  var [keySaved, setKeySaved] = useState(false);
  var [nameSaved, setNameSaved] = useState(false);

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

  // Recent posting stats
  var oneDayAgo = Date.now() - 86400000;
  var todayPosts = (postLog || []).filter(function (p) { return p.at > oneDayAgo; });
  var subCounts = {};
  todayPosts.forEach(function (p) {
    subCounts[p.sub] = (subCounts[p.sub] || 0) + 1;
  });

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg, padding: 20 }}>
      <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: 20 }}>Settings</Text>

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
