import React from 'react';
import { Text } from 'react-native';
import Svg, { Polyline, Circle } from 'react-native-svg';

// Multi-series time chart for spotting correlation between effort and results.
// Each series is normalized to its OWN min/max, so lines with wildly different
// units (effort %, downloads/day, CVR) share one frame and you can see whether
// they move together — the shape matters, not the absolute height.
//
// series: [{ key, label, color, points: [{ date: 'YYYY-MM-DD', value: number }] }]
// Parent decides which series are visible (legend toggle) and passes only those.
export default function CorrelationChart(props) {
  var colors = props.colors;
  var series = props.series || [];
  var VW = 320;
  var VH = props.height || 160;
  var pad = 12;

  var allDates = [];
  series.forEach(function (s) {
    (s.points || []).forEach(function (p) {
      if (typeof p.value === 'number') allDates.push(new Date(p.date).getTime());
    });
  });
  if (allDates.length < 2) {
    return (
      <Text style={{ color: colors.textMuted, fontSize: 12, textAlign: 'center', paddingVertical: 28 }}>
        Not enough data yet. Complete a few actions and log metrics over a couple of
        weeks — the lines appear once there are at least two points in time.
      </Text>
    );
  }
  var xMin = Math.min.apply(null, allDates);
  var xMax = Math.max.apply(null, allDates);

  function xOf(dateStr) {
    if (xMax === xMin) return VW / 2;
    var t = new Date(dateStr).getTime();
    return pad + ((t - xMin) / (xMax - xMin)) * (VW - 2 * pad);
  }

  return (
    <Svg width="100%" height={VH} viewBox={'0 0 ' + VW + ' ' + VH}>
      {series.map(function (s) {
        var pts = (s.points || []).filter(function (p) { return typeof p.value === 'number'; })
          .sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
        if (pts.length === 0) return null;
        var vals = pts.map(function (p) { return p.value; });
        var vMin = Math.min.apply(null, vals);
        var vMax = Math.max.apply(null, vals);
        function yOf(v) {
          if (vMax === vMin) return VH / 2;
          return (VH - pad) - ((v - vMin) / (vMax - vMin)) * (VH - 2 * pad);
        }
        var coords = pts.map(function (p) { return xOf(p.date) + ',' + yOf(p.value); });
        return (
          <React.Fragment key={s.key}>
            {pts.length >= 2 ? (
              <Polyline points={coords.join(' ')} fill="none" stroke={s.color} strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round" />
            ) : null}
            {pts.map(function (p, i) {
              return <Circle key={i} cx={xOf(p.date)} cy={yOf(p.value)} r="2.5" fill={s.color} />;
            })}
          </React.Fragment>
        );
      })}
    </Svg>
  );
}
