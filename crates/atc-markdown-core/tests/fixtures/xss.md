# XSS payloads – none of these may survive rendering

<script>alert('script')</script>

<img src="x.png" onerror="alert('onerror')">

[js link](javascript:alert('link'))

<a href="javascript:alert('raw')">raw js link</a>

<iframe src="https://example.com"></iframe>

<div style="position:fixed;top:0">style attribute</div>

<details><summary>Allowed details</summary>Hidden text</details>
