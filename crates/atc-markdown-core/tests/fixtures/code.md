# Code blocks

```csharp
public sealed class Greeter(ILogger<Greeter> logger)
{
    // Says hello.
    public async Task<string> GreetAsync(string name, int count = 1)
    {
        var message = $"Hello {name}!";
        logger.LogInformation("Greeting {Count} times", count);
        return await Task.FromResult(message);
    }
}
```

```json
{ "name": "atc-markdown", "version": 1, "enabled": true, "tags": ["a", null] }
```

```powershell
# Install the tool
$version = "1.2.3"
Get-ChildItem -Path . -Filter *.md | ForEach-Object { Write-Host $_.Name }
```

```ts
export function add(a: number, b: number): number {
  return a + b; // sum
}
```

```yaml
name: CI
on: [push]
jobs:
  build: { runs-on: windows-latest }
```

```sql
SELECT Id, Name FROM dbo.Customers WHERE Created > '2024-01-01' ORDER BY Name;
```

```bash
cargo test --workspace && echo "done"
```

```xml
<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>
```

```unknownlang
shown as plain text
```
