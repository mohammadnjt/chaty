package com.nicron.webview;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.os.Build;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Push notifications from Chaty's server (Firebase data messages): new
 * messages, a ringing call (with the ringtone, and over the lock screen), and
 * "missed call" when it stops ringing. Tapping one opens the chat.
 */
public class ChatyMessagingService extends FirebaseMessagingService {
    static final String EXTRA_URL = "chaty.url";
    static final String EXTRA_CALL = "chaty.call";
    private static final String MESSAGES = "messages";
    private static final String CALLS = "calls";
    private static final int ID = 1; // notifications are told apart by tag

    @Override
    public void onNewToken(String token) {
        MainActivity.onPushToken(token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        Map<String, String> d = message.getData();
        String type = d.get("type");
        String tag = d.containsKey("tag") ? d.get("tag") : "chaty";
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if ("call-end".equals(type)) {
            // The call stopped ringing; it becomes "missed call" unless answered or declined.
            nm.cancel(tag, ID);
            if (d.get("title") == null) return;
        }
        boolean call = "call".equals(type);
        createChannels(nm);

        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(EXTRA_URL, d.get("url"))
                .putExtra(EXTRA_CALL, call);
        PendingIntent tap = PendingIntent.getActivity(this, tag.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, call ? CALLS : MESSAGES)
                : new Notification.Builder(this);
        b.setSmallIcon(smallIcon())
                .setContentTitle(d.get("title"))
                .setContentText(d.get("body"))
                .setAutoCancel(true)
                .setContentIntent(tap)
                .setShowWhen(true);
        if (call) {
            b.setCategory(Notification.CATEGORY_CALL)
                    .setOngoing(true)
                    .setFullScreenIntent(tap, true)
                    .setPriority(Notification.PRIORITY_MAX);
            if (Build.VERSION.SDK_INT >= 26) b.setTimeoutAfter(45_000);
        } else {
            b.setCategory(Notification.CATEGORY_MESSAGE).setPriority(Notification.PRIORITY_HIGH);
        }
        nm.notify(tag, ID, b.build());
    }

    private int smallIcon() {
        int id = getResources().getIdentifier("ic_stat_chaty", "drawable", getPackageName());
        return id != 0 ? id : getApplicationInfo().icon;
    }

    private void createChannels(NotificationManager nm) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationChannel messages = new NotificationChannel(MESSAGES, "Messages", NotificationManager.IMPORTANCE_HIGH);
        messages.enableVibration(true);
        nm.createNotificationChannel(messages);
        NotificationChannel calls = new NotificationChannel(CALLS, "Calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build());
        calls.enableVibration(true);
        calls.setVibrationPattern(new long[] {0, 800, 500, 800, 500, 800});
        calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(calls);
    }
}
