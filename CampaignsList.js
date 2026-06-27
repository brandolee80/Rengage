import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { loadActionItems, saveActionItems, buildActionItems, itemStatus } from './marketing';

export default function CampaignsList({ colors, campaigns, commentLog, onSelect, onEdit, onDelete, onCreate, generatePlan }) {
  var [planCounts, setPlanCounts] = useState({});
  var [planLoading, setPlanLoading] = useState(null);
  var [error, setError] = useState(null);

  useEffect(function () { loadCounts(); }, [campaigns.length]);

  async function loadCounts() {
    var counts = {};
    for (var i = 0; i < campaigns.length; i++) {
      var its = await loadActionItems(campaigns[i].id);
      counts[campaigns[i].id] = its.filter(function (it) { return itemStatus(it) !== 'removed'; }).length;
    }
    setPlanCounts(counts);
  }

  async function doGeneratePlan(campaign) {
    setPlanLoading(campaign.id); setError(null);
    try {
      var skeleton = await generatePlan(campaign);
      var built = buildActionItems(campaign, skeleton);
      await saveActionItems(campaign.id, built);
      var next = Object.assign({}, planCounts);
      next[campaign.id] = built.length;
      setPlanCounts(next);
      Alert.alert('Plan Ready', built.length + ' action items created for "' + campaign.name + '". See them in the Actions tab.');
    } catch (e) {
      setError(e.message.indexOf('No API key') !== -1 ? 'Add your Gemini API key in Settings.' : e.message);
    }
    setPlanLoading(null);
  }

  function confirmGenerate(campaign) {
    var grade = (campaign.market && campaign.market.grade) || '';
    var has = (planCounts[campaign.id] || 0) > 0;
    var run = function () { doGeneratePlan(campaign); };
    if (grade && 'DF'.indexOf(grade[0]) >= 0) {
      Alert.alert('Market Potential: ' + grade,
        (campaign.market && campaign.market.reasoning ? campaign.market.reasoning + '\n\n' : '') +
        'Marketing effort alone may not overcome these market challenges. Generate a plan anyway?',
        [{ text: 'No, refine first', style: 'cancel' }, { text: 'Yes, market anyway', onPress: run }]);
    } else if (has) {
      Alert.alert('Regenerate Plan?', 'This replaces the current plan for "' + campaign.name + '" with a fresh one.',
        [{ text: 'Cancel', style: 'cancel' }, { text: 'Regenerate', style: 'destructive', onPress: run }]);
    } else {
      run();
    }
  }

  function gradeColor(g) {
    if (!g) return colors.textMuted;
    if ('AB'.indexOf(g[0]) >= 0) return colors.green;
    if (g[0] === 'C') return colors.accent;
    return colors.red;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingBottom: 10 }}>
        <Text style={{ color: colors.text, fontSize: 22, fontWeight: '700' }}>Campaigns</Text>
      </View>

      {error ? <Text style={{ color: colors.red, fontSize: 12, paddingHorizontal: 20, marginBottom: 6 }}>{error}</Text> : null}

      <ScrollView style={{ flex: 1, padding: 20, paddingTop: 0 }}>
        {campaigns.length === 0 ? (
          <View style={{ alignItems: 'center', paddingTop: 80 }}>
            <Text style={{ color: colors.textMuted, fontSize: 16, marginBottom: 8 }}>No campaigns yet</Text>
            <Text style={{ color: colors.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 20 }}>
              Create a campaign for each product{'\n'}or service you want to market
            </Text>
          </View>
        ) : null}

        {campaigns.map(function (c, i) {
          var drafted = Object.keys(commentLog).filter(function (k) { return commentLog[k].campaign === c.name; }).length;
          var grade = (c.market && c.market.grade) || '';
          var count = planCounts[c.id] || 0;
          var loading = planLoading === c.id;
          return (
            <View key={c.id || (c.name + i)} style={{
              backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border,
              borderRadius: 12, padding: 16, marginBottom: 10,
            }}>
              <TouchableOpacity onPress={function () { onSelect(i); }} activeOpacity={0.7}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    {grade ? (
                      <View style={{ backgroundColor: gradeColor(grade), borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2 }}>
                        <Text style={{ color: '#000', fontSize: 12, fontWeight: '800' }}>{grade}</Text>
                      </View>
                    ) : null}
                    <Text style={{ color: colors.text, fontSize: 16, fontWeight: '600', flex: 1 }}>{c.name}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity onPress={function () { onEdit(i); }}
                      style={{ backgroundColor: colors.card2, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 }}>
                      <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: '600' }}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={function () { onDelete(i); }}
                      style={{ backgroundColor: colors.redDim, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 }}>
                      <Text style={{ color: colors.red, fontSize: 12, fontWeight: '600' }}>Del</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 6 }}>
                  {(c.subs || []).length} subs, {(c.keywords || []).length} keywords, {drafted} commented
                </Text>
                {c.context ? (
                  <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 8, lineHeight: 16 }} numberOfLines={2}>{c.context}</Text>
                ) : null}
              </TouchableOpacity>

              <TouchableOpacity onPress={function () { confirmGenerate(c); }} disabled={loading}
                style={{
                  marginTop: 12, padding: 11, borderRadius: 8, alignItems: 'center',
                  flexDirection: 'row', justifyContent: 'center', gap: 8,
                  backgroundColor: count > 0 ? colors.card2 : colors.primary,
                }}>
                {loading ? <ActivityIndicator size="small" color={count > 0 ? colors.text : '#fff'} /> : null}
                <Text style={{ color: count > 0 ? colors.text : '#fff', fontWeight: '600', fontSize: 14 }}>
                  {loading ? 'Generating plan...' : count > 0 ? 'Regenerate Plan · ' + count + ' actions' : 'Ready to Market — Generate Plan'}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })}

        <TouchableOpacity onPress={onCreate}
          style={{ backgroundColor: colors.primary, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 6 }}>
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>+ New Campaign</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}
