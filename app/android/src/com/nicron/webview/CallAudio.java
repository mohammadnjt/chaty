package com.nicron.webview;

import android.app.Activity;
import android.content.pm.PackageManager;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.AudioPlaybackConfiguration;
import android.media.audiofx.AcousticEchoCanceler;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

/**
 * Call audio for the web app, exposed as window.ChatyAudio.
 *
 * The WebView plays calls in "communication" mode but leaves the route to
 * Chromium's defaults, which ignore Bluetooth without a permission prompt and
 * never use the earpiece. This routes calls the way a phone app does:
 * Bluetooth or wired earphones when connected, otherwise the loudspeaker for
 * video calls and the earpiece for voice calls, with a speaker toggle.
 *
 * Chromium only uses communication mode on phones with a hardware echo
 * canceller (the same check is made here); elsewhere call audio is ordinary
 * media that Android already sends to connected earphones, so it is left
 * alone ("media" route). Routing is best effort: a failure here must never
 * break the call.
 */
final class CallAudio {
    private static final String TAG = "ChatyAudio";
    static final int BLUETOOTH_REQUEST = 104;

    private final Activity activity;
    private final WebView webView;
    private final AudioManager am;
    private final Handler main = new Handler(Looper.getMainLooper());

    private boolean active;
    private boolean voice; // Chromium plays the call in communication mode
    private boolean speaker; // loudspeaker when no earphones are in use
    private boolean speakerChosen; // the user tapped the speaker button
    private boolean scoOn;
    private boolean askedBluetooth;
    private int savedMode = AudioManager.MODE_NORMAL;
    private AudioDeviceCallback deviceCallback;
    private String route = "";

    CallAudio(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.am = (AudioManager) activity.getSystemService(Activity.AUDIO_SERVICE);
    }

    // ---------- called from JavaScript (on a background thread) ----------

    /** A call's media started. Video calls start on the loudspeaker. */
    @JavascriptInterface
    public void start(final boolean video) {
        main.post(new Runnable() {
            @Override
            public void run() {
                begin(video);
            }
        });
    }

    @JavascriptInterface
    public void setSpeaker(final boolean on) {
        main.post(new Runnable() {
            @Override
            public void run() {
                speaker = on;
                speakerChosen = true;
                apply();
            }
        });
    }

    @JavascriptInterface
    public void stop() {
        main.post(new Runnable() {
            @Override
            public void run() {
                end();
            }
        });
    }

    /** speaker | earpiece | wired | bluetooth | media, or "" outside a call. */
    @JavascriptInterface
    public String route() {
        return route;
    }

    /** One line for call reports: how Android is actually playing the call. */
    @JavascriptInterface
    public String debug() {
        StringBuilder b = new StringBuilder();
        try {
            b.append("sdk=").append(Build.VERSION.SDK_INT)
                    .append(" aec=").append(AcousticEchoCanceler.isAvailable())
                    .append(" mode=").append(am.getMode())
                    .append(" spk=").append(am.isSpeakerphoneOn())
                    .append(" sco=").append(am.isBluetoothScoOn());
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo dev = am.getCommunicationDevice();
                b.append(" dev=").append(dev == null ? "none" : String.valueOf(dev.getType()));
            }
            if (Build.VERSION.SDK_INT >= 26) {
                // Usage of each sound this app is playing: 1 media, 2 voice call.
                b.append(" play=");
                for (AudioPlaybackConfiguration c : am.getActivePlaybackConfigurations()) {
                    b.append(c.getAudioAttributes().getUsage()).append(',');
                }
            }
            if (Build.VERSION.SDK_INT >= 31 && activity.checkSelfPermission("android.permission.BLUETOOTH_CONNECT") != PackageManager.PERMISSION_GRANTED) {
                b.append(" bt-perm=no");
            }
        } catch (Exception e) {
            b.append(" err=").append(e.getClass().getSimpleName());
        }
        return b.toString();
    }

    // ---------- routing (main thread) ----------

    private void begin(boolean video) {
        try {
            if (!active) {
                active = true;
                voice = AcousticEchoCanceler.isAvailable();
                savedMode = am.getMode();
                speaker = video;
                speakerChosen = false;
                activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                if (voice) watchDevices(true);
            }
            if (!voice) {
                setRoute("media");
                return;
            }
            am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            askForBluetooth();
            apply();
        } catch (Exception e) {
            Log.w(TAG, "start", e);
        }
    }

    private void end() {
        if (!active) return;
        active = false;
        try {
            activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            if (!voice) {
                setRoute("");
                return;
            }
            watchDevices(false);
            if (Build.VERSION.SDK_INT >= 31) {
                am.clearCommunicationDevice();
            } else {
                stopSco();
                am.setSpeakerphoneOn(false);
            }
            am.setMode(savedMode == AudioManager.MODE_IN_COMMUNICATION ? AudioManager.MODE_NORMAL : savedMode);
        } catch (Exception e) {
            Log.w(TAG, "stop", e);
        }
        setRoute("");
    }

    /** Bluetooth earphones need the "Nearby devices" permission on Android 12+. Ask once, only when some are connected. */
    private void askForBluetooth() {
        if (Build.VERSION.SDK_INT < 31 || askedBluetooth || !hasBluetoothDevice()) return;
        if (activity.checkSelfPermission("android.permission.BLUETOOTH_CONNECT") == PackageManager.PERMISSION_GRANTED) return;
        askedBluetooth = true;
        activity.requestPermissions(new String[] {"android.permission.BLUETOOTH_CONNECT"}, BLUETOOTH_REQUEST);
    }

    /** Re-applies the route once the permission answer arrives. */
    void onPermissionResult() {
        apply();
    }

    private void watchDevices(boolean on) {
        if (Build.VERSION.SDK_INT < 23) return;
        if (on && deviceCallback == null) {
            deviceCallback = new AudioDeviceCallback() {
                @Override
                public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
                    // Earphones plugged in or connected: use them.
                    speakerChosen = false;
                    later();
                }

                @Override
                public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
                    later();
                }
            };
            am.registerAudioDeviceCallback(deviceCallback, main);
        } else if (!on && deviceCallback != null) {
            am.unregisterAudioDeviceCallback(deviceCallback);
            deviceCallback = null;
        }
    }

    // Let the WebView react to the change first, then settle the route.
    private void later() {
        main.removeCallbacks(applyLater);
        main.postDelayed(applyLater, 300);
    }

    private final Runnable applyLater = new Runnable() {
        @Override
        public void run() {
            if (active) {
                askForBluetooth();
                apply();
            }
        }
    };

    private void apply() {
        if (!active || !voice) return;
        String want;
        if (speaker && speakerChosen) want = "speaker";
        else if (hasBluetoothDevice()) want = "bluetooth";
        else if (hasWiredDevice()) want = "wired";
        else want = speaker ? "speaker" : "earpiece";
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                AudioDeviceInfo dev = communicationDevice(want);
                if (dev == null && "bluetooth".equals(want)) {
                    want = hasWiredDevice() ? "wired" : speaker ? "speaker" : "earpiece";
                    dev = communicationDevice(want);
                }
                if (dev != null) am.setCommunicationDevice(dev);
            } else if ("bluetooth".equals(want)) {
                am.setSpeakerphoneOn(false);
                if (!scoOn) {
                    am.startBluetoothSco();
                    am.setBluetoothScoOn(true);
                    scoOn = true;
                }
            } else {
                stopSco();
                // The wired headset takes over by itself once the speaker is off.
                am.setSpeakerphoneOn("speaker".equals(want));
            }
        } catch (Exception e) {
            Log.w(TAG, "route " + want, e);
        }
        setRoute(want);
    }

    private void stopSco() {
        if (!scoOn) return;
        scoOn = false;
        try {
            am.setBluetoothScoOn(false);
            am.stopBluetoothSco();
        } catch (Exception e) {
            Log.w(TAG, "sco", e);
        }
    }

    private AudioDeviceInfo communicationDevice(String route) {
        for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
            if (matches(d.getType(), route)) return d;
        }
        return null;
    }

    private static boolean matches(int type, String route) {
        switch (route) {
            case "speaker":
                return type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER;
            case "earpiece":
                return type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
            case "wired":
                return type == AudioDeviceInfo.TYPE_WIRED_HEADSET
                        || type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                        || type == AudioDeviceInfo.TYPE_USB_HEADSET;
            case "bluetooth":
                return type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == 26 /* TYPE_BLE_HEADSET */;
            default:
                return false;
        }
    }

    private boolean hasBluetoothDevice() {
        if (Build.VERSION.SDK_INT >= 31) return communicationDevice("bluetooth") != null || hasOutput("bluetooth");
        if (Build.VERSION.SDK_INT >= 23) return hasOutput("bluetooth");
        return am.isBluetoothA2dpOn() || am.isBluetoothScoOn();
    }

    private boolean hasWiredDevice() {
        if (Build.VERSION.SDK_INT >= 23) return hasOutput("wired");
        return am.isWiredHeadsetOn();
    }

    private boolean hasOutput(String route) {
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int t = d.getType();
            if (matches(t, route)) return true;
            if ("bluetooth".equals(route) && t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP) return true;
        }
        return false;
    }

    private void setRoute(String next) {
        if (next.equals(route)) return;
        route = next;
        // Let the call screen show where the sound goes.
        try {
            webView.evaluateJavascript(
                    "window.dispatchEvent(new CustomEvent('chaty-audio-route',{detail:'" + next + "'}))", null);
        } catch (Exception e) {
            Log.w(TAG, "notify", e);
        }
    }
}
