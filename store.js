import AsyncStorage from '@react-native-async-storage/async-storage';

const store = {
  async get(key) {
    try {
      const val = await AsyncStorage.getItem(key);
      return val ? JSON.parse(val) : null;
    } catch (e) {
      console.warn('store.get error:', key, e);
      return null;
    }
  },

  async set(key, val) {
    try {
      await AsyncStorage.setItem(key, JSON.stringify(val));
    } catch (e) {
      console.warn('store.set error:', key, e);
    }
  },

  async remove(key) {
    try {
      await AsyncStorage.removeItem(key);
    } catch (e) {
      console.warn('store.remove error:', key, e);
    }
  },
};

export default store;
