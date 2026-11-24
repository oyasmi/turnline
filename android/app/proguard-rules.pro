# Sherpa-ONNX accesses Kotlin config fields and callback classes through JNI.
-keep class com.k2fsa.sherpa.onnx.** { *; }
-keep class dev.turnline.android.MatchaSpeech$AudioCallback {
    java.lang.Integer invoke(float[]);
}
