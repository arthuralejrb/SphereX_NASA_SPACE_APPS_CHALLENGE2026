using System.Text.Json;
using SpherexApi.models;

var builder = WebApplication.CreateBuilder(args);

// adds CORS policy
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyOrigin()
              .AllowAnyMethod()
              .AllowAnyHeader());
});

builder.Services.AddOpenApi();

// Timeout de 30s para dar tempo do Python tentar a NASA (10s) e gerar os PNGs
builder.Services.AddHttpClient("ProcessorClient", client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
});

var app = builder.Build();
app.UseCors();

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

// Garante que as pastas wwwroot, images e cache existam antes de subir
var webRootPath = app.Environment.WebRootPath ?? Path.Combine(Directory.GetCurrentDirectory(), "wwwroot");
var imagesDir = Path.Combine(webRootPath, "images");
var cacheDir = Path.Combine(webRootPath, "cache");
Directory.CreateDirectory(imagesDir);
Directory.CreateDirectory(cacheDir);

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/api/targets", () =>
{
    var targets = new[]
    {
        new { name = "WISE 0855", description = "quick movement brown dwarf", ra = "08h55m10.831s", dec = "-7d14m42.53s" },
        new { name = "Barnard's Star", description = "Estrela com maior movimento próprio", ra = "17h57m48.50s", dec = "+04d41m36.1s" },
        new { name = "Epsilon Indi B", description = "Par de anãs marrons em órbita", ra = "22h04m10.52s", dec = "-56d46m57.7s" },
        new { name = "RW Aurigae", description = "Estrela variável jovem", ra = "05h07m49.54s", dec = "+30d24m05.1s" },
        new { name = "R Draconis", description = "Estrela variável pulsante (Mira)", ra = "16h32m40.23s", dec = "+66d45m17.9s" },
    };

    return Results.Ok(targets);
});

app.MapGet("/api/sky", async (string ra, string dec, double? fov, HttpRequest request, IHttpClientFactory httpClientFactory, IConfiguration config) =>
{
    if (string.IsNullOrWhiteSpace(ra) || string.IsNullOrWhiteSpace(dec))
    {
        return Results.BadRequest("request parameters are invalid! inform the ra and dec coordinates!");
    
    }

    var targetFov = fov ?? 0.5;
    var baseUrl = $"{request.Scheme}://{request.Host}";

    // 1. Cria uma chave limpa para o nome do arquivo de cache
    var rawKey = $"{ra.Trim()}_{dec.Trim()}_{targetFov}";
    var safeKey = string.Concat(rawKey.Split(Path.GetInvalidFileNameChars())).Replace(" ", "");
    var cacheFilePath = Path.Combine(cacheDir, $"{safeKey}.json");

    // 2. CACHE HIT: Se já existe no disco, devolve na hora sem chamar o Python
    if (File.Exists(cacheFilePath))
    {
        var cachedJson = await File.ReadAllTextAsync(cacheFilePath);
        var cachedResponse = JsonSerializer.Deserialize<SkyResponse>(cachedJson, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });
        return Results.Ok(cachedResponse);
    }

    // 3. CACHE MISS: Chama o motor Python
    var processorUrl = config["ProcessorUrl"] ?? "http://localhost:5000";
    var client = httpClientFactory.CreateClient("ProcessorClient");

    try
    {
        var pyHttpResponse = await client.PostAsJsonAsync($"{processorUrl}/process", new { ra, dec, fov = targetFov });

        if (!pyHttpResponse.IsSuccessStatusCode)
        {
            return Results.Problem("Error trying to communicate with python API.", statusCode: 502);
        }

        var pyData = await pyHttpResponse.Content.ReadFromJsonAsync<PythonResponse>();

        var response = new SkyResponse
        {
            Ra = ra,
            Dec = dec,
            Fov = targetFov,
            Epochs = pyData?.Epochs?.Select(e => new EpochItem
            {
                Date = e.Date,
                ImageUrl = $"{baseUrl}/images/{e.FileName}"
            }).ToList() ?? [],
            SubtractedImageUrl = pyData?.SubtractedFileName != null ? $"{baseUrl}/images/{pyData.SubtractedFileName}" : null,
            ContaminationFlags = pyData?.ContaminationFlags ?? ["NONE"]
        };

        // 4. Salva no disco para as próximas requisições serem instantâneas
        var jsonToSave = JsonSerializer.Serialize(response, new JsonSerializerOptions { WriteIndented = true });
        await File.WriteAllTextAsync(cacheFilePath, jsonToSave);

        return Results.Ok(response);
    }
    catch (Exception ex)
    {
        return Results.Problem($"Timeout or connection error with Python processor: {ex.Message}", statusCode: 504);
    }
});

app.Run();