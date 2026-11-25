package dev.turnline.android

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle

class MainActivity : ComponentActivity() {
    private val model by viewModels<TurnlineViewModel>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(navigationBarStyle = SystemBarStyle.auto(0x00FFFFFF, 0x00000000))
        setContent {
            val state by model.state.collectAsStateWithLifecycle()
            LaunchedEffect(state.inCall) {
                if (state.inCall) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
            TurnlineTheme(mode = state.settings?.themeMode ?: ThemeMode.SYSTEM) {
                TurnlineApp(model)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        model.setForeground(true)
    }

    override fun onPause() {
        model.setForeground(false)
        super.onPause()
    }
}
