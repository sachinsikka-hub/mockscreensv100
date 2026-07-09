const PREFIX = 'courtiq:';

export const storage = {
  async get(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? null : { value: raw };
    } catch (e) {
      return null;
    }
  },
  async set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, value);
    } catch (e) {}
  },
};
