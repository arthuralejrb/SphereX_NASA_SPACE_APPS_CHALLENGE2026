using SpherexApi.models;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyOrigin()
              .AllowAnyMethod()
              .AllowAnyHeader());
});

// Add services to the container.
// Learn more about configuring OpenAPI at https://aka.ms/aspnet/openapi
builder.Services.AddOpenApi();

var app = builder.Build();
app.UseCors();

// Configure the HTTP request pipeline.
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.Run();
app.UseStaticFiles();

app.MapGet("/api/targets" , () =>
{
    var targets = new []
    {
      new {name = "WISE 0855", description = "quick movement brown dwarf ", ra = "08h55m10,831s", dec = "-7d14m42,53s"},
      new {name = "Barnard's Star", description = "Estrela com maior movimento próprio", ra = "17h57m48.50s", dec = "+04d41m36.1s"},
      new {name = "Epsilon Indi B", description = "Par de anãs marrons em órbita", ra = "22h04m10.52s", dec = "-56d46m57.7s"},
      new {name = "RW Aurigae", description = "Estrela variável jovem", ra = "05h07m49.54s", dec = "+30d24m05.1s"},
      new {name = "R Draconis", description = "Estrela variável pulsante (Mira)", ra = "16h32m40.23s", dec = "+66d45m17.9s"},
    };

    return Results.Ok(targets);
});

app.MapGet("/api/sky/", (string ra, string dec, double? fov, HttpRequest request) =>
{
    
    if(ra == string.Empty || dec == string.Empty || fov == null)
    {
        return Results.BadRequest("request parameters are invalid!");
    } 
    var baseUrl = $"{request.Scheme}://{request.Host}";

    var response = new SkyResponse()
    {
        Ra =  ra,
        Dec = dec,
        Fov = fov,
        Epochs = [
            new EpochItem{Date = "2025-03-15", ImageUrl = $"{baseUrl}/images/mock1.jpeg"},
            new EpochItem{Date = "2025-12-14", ImageUrl = $"{baseUrl}/images/mock3.jpg"}
        ],
        SubtractedImageUrl = $"{baseUrl}/images/mock_diff.png",
        ContaminationFlags = ["NONE"]
        
    };

    return Results.Ok(response);

});
record WeatherForecast(DateOnly Date, int TemperatureC, string? Summary)
{
    public int TemperatureF => 32 + (int)(TemperatureC / 0.5556);
}
