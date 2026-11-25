package dev.turnline.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow

internal enum class CallControlAction { TOGGLE, HANGUP }

internal object CallControlBus {
    private val mutable = MutableSharedFlow<CallControlAction>(extraBufferCapacity = 4)
    val actions = mutable.asSharedFlow()

    fun emit(action: CallControlAction) {
        mutable.tryEmit(action)
    }
}

class CallForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_TOGGLE -> {
                CallControlBus.emit(CallControlAction.TOGGLE)
                return START_NOT_STICKY
            }
            ACTION_HANGUP -> {
                CallControlBus.emit(CallControlAction.HANGUP)
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
        }
        val status = intent?.getStringExtra(EXTRA_STATUS).orEmpty().ifBlank { "通话进行中" }
        val actionLabel = intent?.getStringExtra(EXTRA_ACTION_LABEL).orEmpty().ifBlank { "暂停" }
        ensureChannel()
        val notification = buildNotification(status, actionLabel)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (_: RuntimeException) {
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun ensureChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "语音通话",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "在锁屏或切换应用时保持 Turnline 语音通话"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(status: String, actionLabel: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val contentPending = PendingIntent.getActivity(
            this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val togglePending = PendingIntent.getService(
            this, 1, Intent(this, CallForegroundService::class.java).setAction(ACTION_TOGGLE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val hangupPending = PendingIntent.getService(
            this, 2, Intent(this, CallForegroundService::class.java).setAction(ACTION_HANGUP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_turnline_foreground)
            .setContentTitle("Turnline 通话中")
            .setContentText(status)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(contentPending)
            .addAction(Notification.Action.Builder(null, actionLabel, togglePending).build())
            .addAction(Notification.Action.Builder(null, "挂断", hangupPending).build())
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "turnline_call"
        private const val NOTIFICATION_ID = 1001
        private const val ACTION_START = "dev.turnline.android.action.CALL_START"
        private const val ACTION_STOP = "dev.turnline.android.action.CALL_STOP"
        private const val ACTION_TOGGLE = "dev.turnline.android.action.CALL_TOGGLE"
        private const val ACTION_HANGUP = "dev.turnline.android.action.CALL_HANGUP"
        private const val EXTRA_STATUS = "status"
        private const val EXTRA_ACTION_LABEL = "action_label"

        fun startOrUpdate(context: Context, status: String, actionLabel: String): Boolean {
            val intent = Intent(context, CallForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_STATUS, status)
                putExtra(EXTRA_ACTION_LABEL, actionLabel)
            }
            return try {
                context.startForegroundService(intent)
                true
            } catch (_: RuntimeException) {
                false
            }
        }

        fun stop(context: Context) {
            runCatching {
                context.stopService(Intent(context, CallForegroundService::class.java))
            }
        }
    }
}
