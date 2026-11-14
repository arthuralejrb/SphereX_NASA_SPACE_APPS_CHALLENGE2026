namespace SpherexApi.models
{
    public record SkyResponse
    {
        public string? Ra {get; set;}
        public string? Dec {get; set;}
        public double? Fov {get; set;}
        public List<EpochItem>? Epochs {get; set;}
        public string? SubtractedImageUrl {get; set;}
        public List<string>? ContaminationFlags {get; set;}
    }   

    public record EpochItem
    {
        public string? Date {get; set;}
        public string? ImageUrl {get; set;}

    }
    
}