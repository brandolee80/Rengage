import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

// Cross-platform date picker. iOS renders a self-contained compact control;
// Android shows a tappable date that opens the native dialog.
export default function DateField({ colors, value, onChange, maximumDate }) {
  var [show, setShow] = useState(false);
  var d = value instanceof Date ? value : new Date(value || Date.now());

  function handle(e, picked) {
    if (Platform.OS !== 'ios') setShow(false);
    if (picked && (!e || e.type !== 'dismissed')) onChange(picked);
  }

  if (Platform.OS === 'ios') {
    return <DateTimePicker value={d} mode="date" display="compact" maximumDate={maximumDate} onChange={handle} />;
  }

  return (
    <View>
      <TouchableOpacity onPress={function () { setShow(true); }}
        style={{ backgroundColor: colors.inputBg, borderColor: colors.inputBorder, borderWidth: 1, borderRadius: 8, padding: 11 }}>
        <Text style={{ color: colors.text, fontSize: 14 }}>{d.toLocaleDateString()}</Text>
      </TouchableOpacity>
      {show ? <DateTimePicker value={d} mode="date" display="default" maximumDate={maximumDate} onChange={handle} /> : null}
    </View>
  );
}
