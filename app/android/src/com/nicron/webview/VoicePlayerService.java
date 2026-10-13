package com.nicron.webview;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;

/**
 * Keeps a voice message playing after you leave the app, like Telegram: a
 * foreground service (so Android doesn't freeze the app mid-message) with a
 * media notification, which also answers the lock screen and headset buttons.
 * The page plays the audio; this shows what's playing and hands the buttons
 * back to it as "chaty-player" events: play, pause, stop and seek:<ms>.
 *
 * It's started when playback starts (the app is in front then) and stays in
 * the foreground until the player is closed, paused or not, so the buttons
 * keep working from the background.
 */
public class VoicePlayerService extends Service {
    private static final String CHANNEL = "player";
    private static final int ID = 2;
    private static final String ACTION_SHOW = "chaty.player.show";
    private static final String ACTION_BUTTON = "chaty.player.button";
    private static final String EXTRA_BUTTON = "button";
    private static VoicePlayerService running; // touched on the main thread only

    private MediaSession session;
    private boolean foreground;

    /** Shows or updates the player. Call on the main thread. */
    static void show(Context context, Bundle state) {
        if (running != null) {
            running.apply(state);
            return;
        }
        Intent i = new Intent(context, VoicePlayerService.class).setAction(ACTION_SHOW).putExtras(state);
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
            else context.startService(i);
        } catch (RuntimeException e) {
            // Not allowed from the background: the message just won't outlive the app.
        }
    }

    /** Closes the player. Call on the main thread. */
    static void hide(Context context) {
        if (running != null) running.stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = this;
        session = new MediaSession(this, "ChatyVoice");
        session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                MainActivity.playerButton("play");
            }

            @Override
            public void onPause() {
                MainActivity.playerButton("pause");
            }

            @Override
            public void onStop() {
                MainActivity.playerButton("stop");
            }

            @Override
            public void onSeekTo(long ms) {
                MainActivity.playerButton("seek:" + ms);
            }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_SHOW.equals(action) && intent.getExtras() != null) apply(intent.getExtras());
        else if (ACTION_BUTTON.equals(action)) MainActivity.playerButton(intent.getStringExtra(EXTRA_BUTTON));
        if (!foreground) stopSelf(); // nothing playing to show
        return START_NOT_STICKY;
    }

    private void apply(Bundle s) {
        String title = s.getString("title", "");
        String text = s.getString("text", "");
        boolean playing = s.getBoolean("playing");
        long position = s.getLong("position");
        session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, text)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, s.getLong("duration"))
                .build());
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_STOP | PlaybackState.ACTION_SEEK_TO)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, position,
                        playing ? s.getFloat("rate", 1f) : 0f)
                .build());

        Intent open = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(ChatyMessagingService.EXTRA_URL, s.getString("url"));
        PendingIntent tap = PendingIntent.getActivity(this, ID, open, immutable(PendingIntent.FLAG_UPDATE_CURRENT));

        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Voice messages", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            nm.createNotificationChannel(channel);
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this).setPriority(Notification.PRIORITY_LOW);
        }
        b.setSmallIcon(smallIcon())
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(tap)
                .setDeleteIntent(button("stop"))
                .setShowWhen(false)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(
                        playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "Pause" : "Play", button(playing ? "pause" : "play")).build())
                .addAction(new Notification.Action.Builder(
                        android.R.drawable.ic_menu_close_clear_cancel, "Close", button("stop")).build())
                .setStyle(new Notification.MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(0, 1));
        Notification n = b.build();
        if (foreground) {
            nm.notify(ID, n);
        } else {
            if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(ID, n);
            foreground = true;
        }
    }

    private PendingIntent button(String name) {
        Intent i = new Intent(this, VoicePlayerService.class).setAction(ACTION_BUTTON).putExtra(EXTRA_BUTTON, name);
        return PendingIntent.getService(this, name.hashCode(), i, immutable(PendingIntent.FLAG_UPDATE_CURRENT));
    }

    private static int immutable(int flags) {
        return flags | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
    }

    private int smallIcon() {
        int id = getResources().getIdentifier("ic_stat_chaty", "drawable", getPackageName());
        return id != 0 ? id : getApplicationInfo().icon;
    }

    // Swiped away from recent apps: the page, and its audio, are gone.
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (running == this) running = null;
        session.release();
        stopForeground(true);
        super.onDestroy();
    }
}
