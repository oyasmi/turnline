package dev.turnline.android

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels

class MainActivity : ComponentActivity() {
    private val model by viewModels<TurnlineViewModel>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(navigationBarStyle = SystemBarStyle.auto(0x00FFFFFF, 0x00000000))
        setContent { TurnlineTheme { TurnlineApp(model) } }
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
