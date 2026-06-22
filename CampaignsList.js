import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';

export default function CampaignsList({ colors, campaigns, commentLog, onSelect, onEdit, onDelete, onCreate }) {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingBottom: 10 }}>
        <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700' }}>Campaigns</Text>
      </View>

      <ScrollView style={{ flex: 1, padding: 20, paddingTop: 0 }}>
        {campaigns.length === 0 ? (
          <View style={{ alignItems: 'center', paddingTop: 80 }}>
            <Text style={{ color: colors.textMuted, fontSize: 16, marginBottom: 8 }}>No campaigns yet</Text>
            <Text style={{ color: colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
              Create a campaign for each product{'\n'}or service you want to promote on Reddit
            </Text>
          </View>
        ) : null}

        {campaigns.map(function (c, i) {
          var drafted = Object.keys(commentLog).filter(function (k) { return commentLog[k].campaign === c.name; }).length;
          return (
            <TouchableOpacity
              key={c.name + i}
              onPress={function () { onSelect(i); }}
              style={{
                backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
                borderRadius: 12, padding: 16, marginBottom: 10,
              }}
              activeOpacity={0.7}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600' }}>{c.name}</Text>
                  <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 4 }}>
                    {c.subs.length} subs, {c.keywords.length} keywords, {drafted} commented
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TouchableOpacity
                    onPress={function (e) { e.stopPropagation && e.stopPropagation(); onEdit(i); }}
                    style={{ backgroundColor: colors.card2, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 }}
                  >
                    <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: '600' }}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={function (e) { e.stopPropagation && e.stopPropagation(); onDelete(i); }}
                    style={{ backgroundColor: colors.redDim, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 }}
                  >
                    <Text style={{ color: colors.red, fontSize: 12, fontWeight: '600' }}>Del</Text>
                  </TouchableOpacity>
                </View>
              </View>
              {c.context ? (
                <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 8, lineHeight: 16 }} numberOfLines={2}>
                  {c.context}
                </Text>
              ) : null}
            </TouchableOpacity>
          );
        })}

        <TouchableOpacity
          onPress={onCreate}
          style={{
            backgroundColor: colors.primary, borderRadius: 12, padding: 14,
            alignItems: 'center', marginTop: 6,
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>+ New Campaign</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}
