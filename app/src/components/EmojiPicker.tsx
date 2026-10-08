const GROUPS: [string, string][] = [
  ['Smileys', '😀 😃 😄 😁 😆 😅 😂 🤣 🥲 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🫣 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕'],
  ['Hearts', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ✨ 🌟 ⭐ 🔥 💫'],
  ['Hands', '👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👋 🤚 🖐️ ✋ 👏 🙌 🫶 👐 🤲 🙏 💪'],
  ['Nature', '🌸 🌺 🌼 🌻 🌷 🌹 🥀 💐 🌙 🌛 🌜 🌝 ☀️ 🌤️ ⛅ 🌈 ☁️ 🌧️ ⚡ ❄️ 🌊 🌿 🍀 🍁 🐱 🐶 🐰 🦊 🐻 🐼 🐨 🦋'],
  ['Things', '☕ 🍵 🍰 🎂 🍕 🍔 🍟 🍿 🍩 🍪 🍫 🍓 🍉 🍎 🎉 🎊 🎁 🎈 📷 🎵 🎶 🎮 ⚽ 🏀 📚 ✏️ 💼 💻 📱 ⏰ 🚗 ✈️ 🏠'],
];

export default function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <div className="emoji-panel">
      {GROUPS.map(([label, list]) => (
        <section key={label}>
          <h4>{label}</h4>
          <div className="emoji-grid">
            {list.split(' ').map((e) => (
              <button key={e} type="button" onClick={() => onPick(e)}>
                {e}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
